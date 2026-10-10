import type { Plan } from "@prisma/client";

/**
 * Límites por plan. Todo lo que dependa del plan lee de aquí (nunca números
 * sueltos en la lógica). `null` = sin límite.
 */
export const PLAN_LIMITS: Record<Plan, { monthlyReplies: number | null }> = {
  BASIC: { monthlyReplies: 10 },
  PRO: { monthlyReplies: 100 },
  UNLIMITED: { monthlyReplies: null },
};

/** Tope duro de mensajes salientes por usuario en un día (Lima), sea cual sea su plan. */
export const DAILY_HARD_CAP_PER_USER = 200;

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
  BASIC: "Básico",
  PRO: "Pro",
  UNLIMITED: "Unlimited",
};

/** Precio mensual (S/) de los planes que se venden. null = no se vende. */
export const PLAN_PRICE_PEN: Record<Plan, number | null> = {
  BASIC: 9.9,
  PRO: 19.9,
  UNLIMITED: null,
};

/** Duración estándar del periodo de prueba (solo informativo; la fecha real vive en Subscription). */
export const TRIAL_DAYS = 14;
