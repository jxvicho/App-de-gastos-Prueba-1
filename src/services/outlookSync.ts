import { Client } from "@microsoft/microsoft-graph-client";
import { Prisma, type EmailAccount, type BankSender } from "@prisma/client";
import { prisma } from "../config/prisma";
import { decrypt, encrypt } from "../utils/crypto";
import { getMicrosoftAccessToken } from "./microsoftOAuth";
import { extractTransactionFromEmail } from "./gemini";

const FIRST_SYNC_LOOKBACK_DAYS = 7;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

type EmailAccountWithSenders = EmailAccount & { bankSenders: BankSender[] };

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
      extracted = await extractTransactionFromEmail(bodyText, bank.displayName);
    } catch (err) {
      console.error(`Error extrayendo datos del correo ${message.id}:`, err);
      await sleep(4500);
      continue;
    }
    await sleep(4500);

    if (!extracted.isTransaction || !extracted.amount) continue;

    try {
      await prisma.transaction.create({
        data: {
          userId: account.userId,
          type: extracted.type ?? "EXPENSE",
          amount: extracted.amount,
          currency: extracted.currency ?? "PEN",
          merchant: extracted.merchant,
          description: extracted.description,
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
