import { env } from "../config/env";

/**
 * Cliente mínimo de la API REST de Culqi (https://apidocs.culqi.com). Sin SDK: solo fetch.
 *
 * IMPORTANTE: las rutas de planes y suscripciones (CULQI_PATHS) y los códigos de unidad de tiempo
 * (CULQI_UNIT) se tomaron de la documentación pública y deben comprobarse una vez en sandbox con
 * `npm run culqi:setup` (crea los planes y los muestra). Si Culqi responde 404 o el plan sale con
 * otra frecuencia en el CulqiPanel, solo hay que corregir estas dos constantes.
 */
export const CULQI_PATHS = {
  customers: "/customers",
  cards: "/cards",
  charges: "/charges",
  refunds: "/refunds",
  plansCreate: "/recurrent/plans/create/",
  plansList: "/recurrent/plans/",
  subscriptionsCreate: "/recurrent/subscriptions/create/",
  subscriptionById: (id: string) => `/recurrent/subscriptions/${id}`,
} as const;

/** Valores de `interval_unit_time` de un plan. Gastia solo usa días (prueba) y meses (mensual, trimestral y anual = 12 meses). */
export const CULQI_UNIT = { DAYS: 1, MONTHS: 3 } as const;

export class CulqiError extends Error {
  constructor(message: string, public status: number, public body?: unknown) {
    super(message);
    this.name = "CulqiError";
  }
}

export function isCulqiConfigured(): boolean {
  return !!env.CULQI_SECRET_KEY && !!env.CULQI_PUBLIC_KEY;
}

async function call<T>(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body?: unknown): Promise<T> {
  if (!env.CULQI_SECRET_KEY) throw new CulqiError("Los pagos no están configurados todavía", 503);
  const res = await fetch(`${env.CULQI_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CULQI_SECRET_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* respuesta no JSON */
  }
  if (!res.ok) {
    const b = (json ?? {}) as { user_message?: string; merchant_message?: string };
    // user_message es apto para mostrarse al usuario; merchant_message es técnico y solo va al log.
    console.error(`Culqi ${method} ${path} → ${res.status}`, text.slice(0, 500));
    throw new CulqiError(b.user_message || b.merchant_message || `Culqi respondió ${res.status}`, res.status, json);
  }
  return json as T;
}

export interface CulqiCustomer { id: string }
export interface CulqiCard {
  id: string;
  source?: { iin?: { card_brand?: string }; last_four?: string; card_number?: string; expiration_month?: number; expiration_year?: number };
}
export interface CulqiPlan { id: string; amount?: number; interval_unit_time?: number; interval_count?: number; name?: string }
export interface CulqiSubscription {
  id: string;
  status?: number | string;
  next_billing_date?: number;
  trial_start?: number;
  trial_end?: number;
  current_period?: number;
}
export interface CulqiCharge {
  id: string;
  amount?: number;
  currency_code?: string;
  email?: string;
  outcome?: { type?: string; user_message?: string; merchant_message?: string };
  source?: { id?: string };
  metadata?: Record<string, unknown>;
  creation_date?: number;
}

export function createCustomer(input: {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  city: string;
}): Promise<CulqiCustomer> {
  return call("POST", CULQI_PATHS.customers, {
    email: input.email,
    first_name: input.firstName,
    last_name: input.lastName,
    phone_number: input.phone,
    address: input.address,
    address_city: input.city,
    country_code: "PE",
  });
}

export function createCard(customerId: string, tokenId: string): Promise<CulqiCard> {
  return call("POST", CULQI_PATHS.cards, { customer_id: customerId, token_id: tokenId });
}

export function createPlan(input: {
  name: string;
  shortName: string;
  description: string;
  amountCents: number;
  months: number;
  trialDays: number;
}): Promise<CulqiPlan> {
  return call("POST", CULQI_PATHS.plansCreate, {
    name: input.name,
    short_name: input.shortName,
    description: input.description,
    amount: input.amountCents,
    currency: "PEN",
    interval_unit_time: CULQI_UNIT.MONTHS,
    interval_count: input.months,
    // Prueba: N días sin cobro; el primer cobro llega al terminar. Con 0 no hay prueba.
    initial_cycles: {
      count: input.trialDays,
      has_initial_charge: false,
      amount: 0,
      interval_unit_time: CULQI_UNIT.DAYS,
    },
    metadata: { app: "gastia" },
  });
}

export function listPlans(): Promise<unknown> {
  return call("GET", CULQI_PATHS.plansList);
}

export function createSubscription(cardId: string, planId: string, metadata: Record<string, string>): Promise<CulqiSubscription> {
  return call("POST", CULQI_PATHS.subscriptionsCreate, { card_id: cardId, plan_id: planId, tyc: true, metadata });
}

export function getSubscription(id: string): Promise<CulqiSubscription> {
  return call("GET", CULQI_PATHS.subscriptionById(id));
}

export function cancelSubscription(id: string): Promise<unknown> {
  return call("DELETE", CULQI_PATHS.subscriptionById(id));
}

export function getCharge(id: string): Promise<CulqiCharge> {
  return call("GET", `${CULQI_PATHS.charges}/${id}`);
}

/** Extorno/devolución. Culqi NO devuelve la comisión de la venta original. */
export function refundCharge(chargeId: string, amountCents: number): Promise<{ id: string }> {
  return call("POST", CULQI_PATHS.refunds, { charge_id: chargeId, amount: amountCents, reason: "solicitud_comprador" });
}

/** Culqi envía fechas en segundos o en milisegundos según el recurso: se normaliza a Date. */
export function culqiDate(value: number | undefined | null): Date | null {
  if (!value || !Number.isFinite(value)) return null;
  return new Date(value < 1e12 ? value * 1000 : value);
}
