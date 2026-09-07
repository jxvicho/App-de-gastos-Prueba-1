import "dotenv/config";
import { z } from "zod";

/**
 * Validamos todas las variables de entorno una sola vez al arrancar.
 * Si falta algo crítico, la app falla rápido con un mensaje claro
 * en vez de romperse a mitad de una petición en producción.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_BASE_URL: z.string().url(),
  DASHBOARD_BASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default("7d"),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),

  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GOOGLE_REDIRECT_URI: z.string().optional().default(""),
  GOOGLE_PUBSUB_TOPIC: z.string().optional().default(""),

  MS_CLIENT_ID: z.string().optional().default(""),
  MS_CLIENT_SECRET: z.string().optional().default(""),
  MS_TENANT_ID: z.string().optional().default("common"),
  MS_REDIRECT_URI: z.string().optional().default(""),

  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(""),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().optional().default(""),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional().default(""),
  WHATSAPP_APP_SECRET: z.string().optional().default(""),

  ANTHROPIC_API_KEY: z.string().optional().default(""),

  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL_EXTRACTION: z.string().default("gemini-2.5-flash"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Variables de entorno inválidas:", parsed.error.flatten().fieldErrors);
  throw new Error("Configuración de entorno inválida. Revisa tu archivo .env contra .env.example");
}

export const env = parsed.data;
