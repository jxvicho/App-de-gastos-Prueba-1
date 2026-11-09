import type { Plan, BillingPeriod } from "@prisma/client";

/**
 * Límites por plan. Todo lo que dependa del plan lee de aquí (nunca números
 * sueltos en la lógica). `null` = sin límite.
 */
export const PLAN_LIMITS: Record<Plan, { monthlyReplies: number | null }> = {
  FREE: { monthlyReplies: 0 }, // sin WhatsApp
  BASIC: { monthlyReplies: 0 }, // sin respuestas del bot por WhatsApp (el chat web sí, en todos los planes)
  PRO: { monthlyReplies: 0 }, // igual: el Pro suma registro automático opcional y resumen diario
  UNLIMITED: { monthlyReplies: null },
};

/** Tope duro de mensajes salientes por usuario en un día (Lima), sea cual sea su plan. */
/**
 * Tipos de mensaje que CUENTAN para el tope mensual del plan (respuestas del chat, alertas y avisos de consumo).
 * NO cuentan: resúmenes programados (diario/semanal), código de verificación, bienvenida y el aviso de límite alcanzado.
 */
export const COUNTED_MESSAGE_KINDS = ["reply", "alert", "txn_notification"] as const;

export const DAILY_HARD_CAP_PER_USER = 50;

/** Hora fija (Lima) del resumen diario: todos los días a esa hora se envía el resumen del día anterior completo. */
export const DAILY_SUMMARY_HOUR_LIMA = 9;

/** Tope duro de mensajes del chat web por usuario y día (Lima): no cuesta Meta, pero sí IA. Para todos los planes. */
export const WEB_CHAT_HARD_CAP_PER_USER = 100;

/** Tarifa de Meta (USD por mensaje entregado, Perú) usada cuando Meta no informa la categoría. */
export const META_RATE_USD_PE = 0.03;

/** Tarifas por categoría de cobro (USD). Marketing cuesta más: por eso el contenido debe ser 100% transaccional. */
export const META_RATE_BY_CATEGORY_USD: Record<string, number> = {
  service: 0.03,
  utility: 0.03,
  authentication: 0.03,
  marketing: 0.0703,
};

/** Mensajes de servicio gratis al mes por número de negocio (compartidos entre todos los usuarios). */
export const META_FREE_SERVICE_MESSAGES_PER_MONTH = 1000;

/** Nombre que ve el usuario. UNLIMITED nunca se ofrece en la web: solo se muestra a quien ya lo tiene. */
export const PLAN_LABELS: Record<Plan, string> = {
  FREE: "Gratis",
  BASIC: "Básico",
  PRO: "Pro",
  UNLIMITED: "Unlimited",
};

/** Precio mensual (S/) de los planes que se venden. null = no se vende. */
export const PLAN_PRICE_PEN: Record<Plan, number | null> = {
  FREE: 0,
  BASIC: 14.9,
  PRO: 19.9,
  UNLIMITED: null,
};

/** Periodos de facturación y precio (S/) por periodo. Definidos el 29-oct-2026; aún no los usa ninguna ruta (falta la pasarela). */
export type { BillingPeriod } from "@prisma/client";
export const PLAN_PRICE_BY_PERIOD_PEN: Record<"BASIC" | "PRO", Record<BillingPeriod, number>> = {
  BASIC: { MONTHLY: 14.9, QUARTERLY: 39.9, ANNUAL: 149.9 },
  PRO: { MONTHLY: 19.9, QUARTERLY: 54.9, ANNUAL: 199.9 },
};

/**
 * Días de prueba sin cobro por periodo (definido el 30-oct-2026): 7 en mensual y trimestral, 14 en anual.
 * El plan anual NO tiene reembolso: la prueba más larga ocupa su lugar. Cancelando antes de que termine no se cobra nada.
 */
export const TRIAL_DAYS_BY_PERIOD: Record<BillingPeriod, number> = { MONTHLY: 7, QUARTERLY: 7, ANNUAL: 14 };

/** Duración estándar del periodo de prueba (mensual/trimestral). La real de cada usuario vive en Subscription. */
export const TRIAL_DAYS = 7;

export const BILLING_PERIODS: BillingPeriod[] = ["MONTHLY", "QUARTERLY", "ANNUAL"];

export const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = {
  MONTHLY: "Mensual",
  QUARTERLY: "Trimestral",
  ANNUAL: "Anual",
};

/** Cada cuántos meses se cobra cada periodo. */
export const BILLING_PERIOD_MONTHS: Record<BillingPeriod, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };

/** Planes que se venden (el resto, como UNLIMITED, no tienen pasarela). */
export type SellablePlan = "BASIC" | "PRO";
export const SELLABLE_PLANS: SellablePlan[] = ["BASIC", "PRO"];

/** Cobros fallidos consecutivos: avisos y limitación de acceso (política definida el 30-oct-2026). */
export const DUNNING = {
  /** Cobro inicial + 4 reintentos diarios de Culqi = 5 intentos; al 5.º fallo la suscripción se cancela. */
  MAX_ATTEMPTS: 5,
  /** Desde este intento fallido el acceso pasa a solo lectura. */
  RESTRICT_AT_ATTEMPT: 3,
};

/**
 * Qué puede hacer cada plan. FUENTE ÚNICA: el backend (permisos) y la pestaña "Planes" del panel Admin leen de aquí.
 * Cambiar un valor aquí cambia el comportamiento y lo que muestra el panel.
 */
export interface PlanFeatures {
  /** Conectar Gmail/Outlook y leer los consumos del correo. */
  emailSync: boolean;
  /** Usar el bot por WhatsApp (el chat web no depende de esto). */
  whatsapp: boolean;
  /** Puede activar el registro automático (sin confirmar uno por uno). */
  autoRegister: boolean;
  /** Resumen diario por WhatsApp. */
  dailySummary: boolean;
  /** Alertas de gasto alto. */
  alerts: boolean;
  /** Crear categorías propias (renombrar/eliminar las propias va con esto). */
  createCategories: boolean;
  /** Avisos de cada consumo por WhatsApp (el aviso por chat web llega a todos). */
  perTxnWhatsapp: boolean;
  /** Tope de mensajes del chat web por día (Lima). */
  webChatDailyCap: number;
  /** Máximo de correos conectados (0 = no puede). */
  maxEmailAccounts: number;
  /** Notas de voz y fotos (boletas, capturas) en el chat web. Gratis solo escribe texto. */
  chatMedia: boolean;
  /** Mascotas premium (chancho y capibara). Gratis solo tiene perro, gato o ninguna. */
  premiumPets: boolean;
}

export const PLAN_FEATURES: Record<Plan, PlanFeatures> = {
  FREE: { emailSync: false, whatsapp: false, autoRegister: false, dailySummary: false, alerts: false, createCategories: false, perTxnWhatsapp: false, webChatDailyCap: 5, maxEmailAccounts: 0, premiumPets: false, chatMedia: false },
  BASIC: { emailSync: true, whatsapp: true, autoRegister: false, dailySummary: false, alerts: false, createCategories: true, perTxnWhatsapp: false, webChatDailyCap: WEB_CHAT_HARD_CAP_PER_USER, maxEmailAccounts: 2, premiumPets: true, chatMedia: true },
  PRO: { emailSync: true, whatsapp: true, autoRegister: true, dailySummary: true, alerts: true, createCategories: true, perTxnWhatsapp: false, webChatDailyCap: WEB_CHAT_HARD_CAP_PER_USER, maxEmailAccounts: 2, premiumPets: true, chatMedia: true },
  UNLIMITED: { emailSync: true, whatsapp: true, autoRegister: true, dailySummary: true, alerts: true, createCategories: true, perTxnWhatsapp: true, webChatDailyCap: WEB_CHAT_HARD_CAP_PER_USER, maxEmailAccounts: 2, premiumPets: true, chatMedia: true },
};

/** Planes visibles hoy en la web (Básico y Unlimited quedan ocultos; siguen existiendo para datos y overrides). */
export const VISIBLE_PLANS: Plan[] = ["FREE", "PRO"];

/** Precio por periodo (S/) de cada plan que se vende. Gratis = 0. */
export const PLAN_PRICES_FOR_PANEL: Partial<Record<Plan, Record<BillingPeriod, number>>> = {
  FREE: { MONTHLY: 0, QUARTERLY: 0, ANNUAL: 0 },
  BASIC: PLAN_PRICE_BY_PERIOD_PEN.BASIC,
  PRO: PLAN_PRICE_BY_PERIOD_PEN.PRO,
};
