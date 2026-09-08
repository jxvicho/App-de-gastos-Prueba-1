import { Client } from "@microsoft/microsoft-graph-client";
import { Prisma, type EmailAccount, type BankSender, type User, type CategoryRule } from "@prisma/client";
import { prisma } from "../config/prisma";
import { decrypt, encrypt } from "../utils/crypto";
import { getMicrosoftAccessToken } from "./microsoftOAuth";
import { extractTransactionFromEmail } from "./gemini";
import { notifyPendingTransaction } from "./whatsappBot";
import { normalizeText } from "../utils/text";

type RuleWithCategory = CategoryRule & { category: { id: string; name: string } };

/**
 * Evalúa las reglas del usuario (ya ordenadas por createdAt desc) contra un
 * movimiento recién extraído, y devuelve la categoría de la PRIMERA que
 * coincida — es decir, si hay dos reglas que aplican, gana la más reciente.
 * Las reglas del usuario tienen prioridad sobre lo que sugiera Gemini.
 */
function findMatchingRuleCategory(
  rules: RuleWithCategory[],
  merchant: string | undefined,
  amount: number
): { id: string; name: string } | undefined {
  const normalizedMerchant = merchant ? normalizeText(merchant) : "";

  for (const rule of rules) {
    switch (rule.type) {
      case "MERCHANT_CONTAINS":
        if (normalizedMerchant && normalizedMerchant.includes(normalizeText(rule.value))) {
          return rule.category;
        }
        break;
      case "AMOUNT_GREATER_THAN":
        if (amount > parseFloat(rule.value)) return rule.category;
        break;
      case "AMOUNT_LESS_THAN":
        if (amount < parseFloat(rule.value)) return rule.category;
        break;
      case "AMOUNT_EQUALS":
        if (Math.abs(amount - parseFloat(rule.value)) < 0.01) return rule.category;
        break;
    }
  }
  return undefined;
}

const FIRST_SYNC_LOOKBACK_DAYS = 7;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

type EmailAccountWithSenders = EmailAccount & { bankSenders: BankSender[]; user: User };

export async function syncOutlookAccount(account: EmailAccountWithSenders): Promise<void> {
  if (account.bankSenders.length === 0) return;

  const serializedCache = decrypt(account.refreshToken);
  const { homeAccountId } = JSON.parse(decrypt(account.accessToken)) as { homeAccountId: string };

  const { accessToken, updatedCache } = await getMicrosoftAccessToken(serializedCache, homeAccountId);

  if (updatedCache !== serializedCache) {
    await prisma.emailAccount.update({
      where: { id: account.id },
      data: { refreshToken: encrypt(updatedCache) },
    });
  }

  const client = Client.init({ authProvider: (done) => done(null, accessToken) });

  const since = account.lastSyncedAt ?? new Date(Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 86_400_000);
  const sinceIso = since.toISOString();

  const senderToBank = new Map<string, BankSender>();
  for (const bank of account.bankSenders) {
    for (const senderEmail of bank.senderEmails) {
      senderToBank.set(senderEmail.toLowerCase(), bank);
    }
  }

  // Categorías reales del usuario, para pedirle a Gemini que sugiera una y
  // para resolver el nombre que devuelva al id real (tolerante a mayúsculas/tildes).
  const categories = await prisma.category.findMany({
    where: { userId: account.userId, isArchived: false },
    select: { id: true, name: true },
  });
  const categoryNames = categories.map((c) => c.name);
  const categoryByNormalizedName = new Map(categories.map((c) => [normalizeText(c.name), c]));

  // Reglas de categorización explícitas del usuario, más recientes primero.
  const activeRules = await prisma.categoryRule.findMany({
    where: { userId: account.userId, isActive: true },
    include: { category: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  let allMessages: any[] = [];
  try {
    const result = await client
      .api("/me/messages")
      .header("ConsistencyLevel", "eventual")
      .filter(`receivedDateTime ge ${sinceIso}`)
      .orderby("receivedDateTime desc")
      .count(true)
      .top(100)
      .select("id,subject,body,receivedDateTime,from")
      .get();
    allMessages = result.value ?? [];
  } catch (err) {
    console.error("Error consultando correos (Outlook):", err);
    return;
  }

  const matchedMessages = allMessages.filter((message) => {
    const address = message.from?.emailAddress?.address?.toLowerCase();
    return !!address && senderToBank.has(address);
  });

  let createdCount = 0;

  for (const message of matchedMessages) {
    const address = message.from.emailAddress.address.toLowerCase() as string;
    const bank = senderToBank.get(address)!;

    const alreadyProcessed = await prisma.transaction.findFirst({
      where: { userId: account.userId, rawEmailId: message.id },
      select: { id: true },
    });
    if (alreadyProcessed) continue;

    const rawBody = message.body?.content ?? "";
    const bodyText = message.body?.contentType === "text" ? rawBody : stripHtml(rawBody);
    if (!bodyText) continue;

    let extracted;
    try {
      extracted = await extractTransactionFromEmail(bodyText, bank.displayName, categoryNames);
    } catch (err) {
      console.error(`Error extrayendo datos del correo ${message.id}:`, err);
      await sleep(4500);
      continue;
    }
    await sleep(4500);

    if (!extracted.isTransaction || !extracted.amount) continue;

    const geminiCategory = extracted.suggestedCategory
      ? categoryByNormalizedName.get(normalizeText(extracted.suggestedCategory))
      : undefined;
    if (extracted.suggestedCategory && !geminiCategory) {
      console.log(`Gemini sugirió una categoría que no coincide con ninguna real: "${extracted.suggestedCategory}"`);
    }

    // Las reglas explícitas del usuario ganan sobre la sugerencia de Gemini.
    const ruleCategory = findMatchingRuleCategory(activeRules, extracted.merchant, extracted.amount);
    if (ruleCategory) {
      console.log(`Regla de categorización aplicada: "${extracted.merchant}" -> ${ruleCategory.name}`);
    }
    const matchedCategory = ruleCategory ?? geminiCategory;

    try {
      const created = await prisma.transaction.create({
        data: {
          userId: account.userId,
          type: extracted.type ?? "EXPENSE",
          amount: extracted.amount,
          currency: extracted.currency ?? "PEN",
          merchant: extracted.merchant,
          description: extracted.description,
          categoryId: matchedCategory?.id,
          bankKey: bank.bankKey,
          source: "EMAIL_AUTO",
          status: "PENDING_CONFIRMATION",
          occurredAt: extracted.occurredAt
            ? new Date(extracted.occurredAt)
            : new Date(message.receivedDateTime),
          rawEmailId: message.id,
          extractionMeta: extracted as any,
        },
      });
      createdCount++;
      await notifyPendingTransaction(
        { ...created, category: matchedCategory ? { name: matchedCategory.name } : null },
        account.user.phoneNumber
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        console.log("Transacción duplicada omitida (correo ya procesado)");
        continue;
      }
      console.error(`Error guardando la transacción del correo ${message.id}:`, err);
    }
  }

  console.log(`Cuenta ${account.emailAddress}: ${createdCount} transacciones nuevas creadas`);

  await prisma.emailAccount.update({
    where: { id: account.id },
    data: { lastSyncedAt: new Date() },
  });
}
