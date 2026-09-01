import crypto from "crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";

// La clave debe tener 32 bytes. Si TOKEN_ENCRYPTION_KEY es un string normal,
// lo derivamos a 32 bytes con sha256 para no obligar a que sea exactamente hex/base64.
const KEY = crypto.createHash("sha256").update(env.TOKEN_ENCRYPTION_KEY).digest();

/**
 * Encripta un texto plano (ej. un access_token de Google/Microsoft) antes de
 * guardarlo en la base de datos. Nunca guardamos tokens OAuth sin encriptar.
 */
export function encrypt(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Empaquetamos iv + authTag + ciphertext en un solo string base64
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decrypt(payload: string): string {
  const buffer = Buffer.from(payload, "base64");
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
