import type { BankSender } from "@prisma/client";
import { prisma } from "../config/prisma";

/**
 * Dominios por banco, usados como RESPALDO cuando el correo no viene de un
 * remitente exacto conocido (BankSender.senderEmails). Un correo cuyo dominio
 * coincide (o es subdominio) solo se acepta si además pasa DKIM/SPF para ese
 * dominio, y entra siempre como pendiente de confirmación. Al confirmarlo, la
 * dirección exacta se aprende (learnConfirmedSenders) y de ahí en adelante se
 * procesa como remitente conocido. Cuando se tengan los remitentes reales de
 * cada banco, basta con cargarlos en el catálogo y vaciar esta tabla.
 */
export const BANK_DOMAINS: Record<string, string[]> = {
  bcp: ["notificabcp.com.pe", "viabcp.com", "bcp.com.pe"],
  interbank: ["interbank.pe", "interbank.com.pe"],
  bbva_pe: ["bbva.com.pe", "bbva.pe"],
  scotiabank_pe: ["scotiabank.com.pe"],
  yape: ["yape.com.pe"],
  banco_pichincha: ["pichincha.pe", "pichincha.com.pe"],
  banco_falabella: ["bancofalabella.pe", "bancofalabella.com.pe"],
  agora: ["agora.pe"],
  sip: ["sip.pe"],
  diners: ["dinersclub.com.pe"],
  io: ["io.pe"],
  banbif: ["banbif.com.pe"],
  banco_nacion: ["bn.com.pe"],
  lemon_cash: ["lemon.me"],
};

/** "Banco X <alertas@banco.com>" -> "alertas@banco.com" */
export function parseAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

function domainMatches(value: string, domain: string): boolean {
  const v = value.replace(/^.*@/, "").replace(/["'>]/g, "").trim();
  return v === domain || v.endsWith("." + domain);
}

/** ¿El encabezado Authentication-Results acredita (DKIM o SPF) que el correo es realmente de ese dominio? */
export function authPassesFor(authResults: string, domain: string): boolean {
  const ar = (authResults || "").toLowerCase();
  if (!ar || /dmarc=fail/.test(ar)) return false;
  for (const m of ar.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=([^\s;]+)/g)) {
    if (domainMatches(m[1], domain)) return true;
  }
  for (const m of ar.matchAll(/spf=pass[^;]*?smtp\.mailfrom=([^\s;]+)/g)) {
    if (domainMatches(m[1], domain)) return true;
  }
  return false;
}

export type SenderIndex = {
  exact: Map<string, BankSender>;
  domains: { domain: string; bank: BankSender }[];
};

export function buildSenderIndex(banks: BankSender[]): SenderIndex {
  const exact = new Map<string, BankSender>();
  const domains: { domain: string; bank: BankSender }[] = [];
  for (const bank of banks) {
    for (const e of bank.senderEmails) exact.set(e.toLowerCase(), bank);
    for (const d of BANK_DOMAINS[bank.bankKey] ?? []) domains.push({ domain: d, bank });
  }
  return { exact, domains };
}

/** Términos para la búsqueda `from:(...)` de Gmail: direcciones exactas + dominios. */
export function searchTerms(index: SenderIndex): string[] {
  return [...new Set([...index.exact.keys(), ...index.domains.map((d) => d.domain)])];
}

export type SenderMatch = { bank: BankSender; address: string; viaDomain: boolean };

export function matchSender(fromHeader: string, authResults: string, index: SenderIndex): SenderMatch | null {
  const address = parseAddress(fromHeader);
  if (!address) return null;
  const known = index.exact.get(address);
  if (known) return { bank: known, address, viaDomain: false };
  for (const { domain, bank } of index.domains) {
    if (domainMatches(address, domain) && authPassesFor(authResults, domain)) {
      return { bank, address, viaDomain: true };
    }
  }
  return null;
}

/**
 * Aprende remitentes: si un movimiento detectado por dominio ya fue confirmado
 * por el usuario, su dirección exacta pasa a ser un remitente conocido.
 */
export async function learnConfirmedSenders(userId: string, banks: BankSender[]): Promise<void> {
  if (banks.length === 0) return;
  const txns = await prisma.transaction.findMany({
    where: {
      userId,
      source: "EMAIL_AUTO",
      status: "CONFIRMED",
      bankKey: { in: banks.map((b) => b.bankKey) },
      createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) },
    },
    select: { bankKey: true, extractionMeta: true },
  });
  for (const t of txns) {
    const meta = t.extractionMeta as { matchedByDomain?: boolean; senderAddress?: string } | null;
    if (!meta?.matchedByDomain || !meta.senderAddress) continue;
    const bank = banks.find((b) => b.bankKey === t.bankKey);
    if (!bank || bank.senderEmails.includes(meta.senderAddress)) continue;
    await prisma.bankSender.update({ where: { id: bank.id }, data: { senderEmails: { push: meta.senderAddress } } });
    bank.senderEmails.push(meta.senderAddress);
    console.log(`Remitente aprendido para ${bank.displayName}: ${meta.senderAddress}`);
  }
}
