import { Prisma, type EmailAccount, type BankSender, type User } from "@prisma/client";
import type { gmail_v1 } from "googleapis";
import { prisma } from "../config/prisma";
import { decrypt } from "../utils/crypto";
import { getGmailClient } from "./googleOAuth";
import { extractTransactionFromEmail } from "./gemini";
import { resolveIngestStatus, afterEmailTransactionCreated } from "./emailIngest";
import { normalizeText } from "../utils/text";
import { findMatchingRuleCategory, sleep, stripHtml } from "./outlookSync";

const FIRST_SYNC_LOOKBACK_DAYS = 7;

type EmailAccountWithSenders = EmailAccount & { bankSenders: BankSender[]; user: User };

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/** Busca el cuerpo en text/plain y, si no hay, en text/html (recorriendo partes anidadas). */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  let plain = "";
  let html = "";
  const walk = (part: gmail_v1.Schema$MessagePart) => {
    const data = part.body?.data;
    if (data) {
      if (part.mimeType === "text/plain") plain += decodeBase64Url(data);
      else if (part.mimeType === "text/html") html += decodeBase64Url(data);
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  return plain.trim() || stripHtml(html);
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** "Banco X <alertas@banco.com>" -> "alertas@banco.com" */
function parseAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

export async function syncGmailAccount(account: EmailAccountWithSenders): Promise<void> {
  if (account.bankSenders.length === 0) return;

  const gmail = getGmailClient(decrypt(account.refreshToken));

  const since = account.lastSyncedAt ?? new Date(Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 86_400_000);
  const afterEpoch = Math.floor(since.getTime() / 1000);

  const senderToBank = new Map<string, BankSender>();
  for (const bank of account.bankSenders) {
    for (const senderEmail of bank.senderEmails) senderToBank.set(senderEmail.toLowerCase(), bank);
  }
  if (senderToBank.size === 0) return;

  const categories = await prisma.category.findMany({
    where: { userId: account.userId, isArchived: false },
    select: { id: true, name: true },
  });
  const categoryNames = categories.map((c) => c.name);
  const categoryByNormalizedName = new Map(categories.map((c) => [normalizeText(c.name), c]));

  const activeRules = await prisma.categoryRule.findMany({
    where: { userId: account.userId, isActive: true },
    include: { category: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  const query = `from:(${[...senderToBank.keys()].join(" OR ")}) after:${afterEpoch}`;

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 100 });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    console.error("Error consultando correos (Gmail):", err);
    return;
  }

  let createdCount = 0;

  for (const id of messageIds) {
    // Prefijo "gmail:" para que el id nunca choque con ids de Outlook en rawEmailId.
    const rawEmailId = `gmail:${id}`;

    const alreadyProcessed = await prisma.transaction.findFirst({
      where: { userId: account.userId, rawEmailId },
      select: { id: true },
    });
    if (alreadyProcessed) continue;

    let msg: gmail_v1.Schema$Message;
    try {
      msg = (await gmail.users.messages.get({ userId: "me", id, format: "full" })).data;
    } catch (err) {
      console.error(`Error leyendo el correo ${id} (Gmail):`, err);
      continue;
    }

    const bank = senderToBank.get(parseAddress(header(msg, "From")));
    if (!bank) continue;

    const bodyText = extractBody(msg.payload);
    if (!bodyText) continue;

    let extracted;
    try {
      extracted = await extractTransactionFromEmail(bodyText, bank.displayName, categoryNames);
    } catch (err) {
      console.error(`Error extrayendo datos del correo ${id}:`, err);
      await sleep(4500);
      continue;
    }
    await sleep(4500);

    if (!extracted.isTransaction || !extracted.amount) continue;

    const geminiCategory = extracted.suggestedCategory
      ? categoryByNormalizedName.get(normalizeText(extracted.suggestedCategory))
      : undefined;
    const ruleCategory = findMatchingRuleCategory(activeRules, extracted.merchant, extracted.amount);
    const matchedCategory = ruleCategory ?? geminiCategory;

    const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();

    try {
      const ingestStatus = await resolveIngestStatus(account.user);
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
          status: ingestStatus,
          occurredAt: extracted.occurredAt ? new Date(extracted.occurredAt) : receivedAt,
          rawEmailId,
          extractionMeta: extracted as any,
        },
      });
      createdCount++;
      await afterEmailTransactionCreated(account.user, created, matchedCategory ? { id: matchedCategory.id, name: matchedCategory.name } : null);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      console.error(`Error guardando la transacción del correo ${id}:`, err);
    }
  }

  console.log(`Cuenta Gmail ${account.emailAddress}: ${createdCount} transacciones nuevas creadas`);

  await prisma.emailAccount.update({ where: { id: account.id }, data: { lastSyncedAt: new Date() } });
}
