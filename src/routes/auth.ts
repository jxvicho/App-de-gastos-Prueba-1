import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { asyncHandler } from "../middleware/asyncHandler";
import { ALL_DEFAULT_CATEGORIES } from "../utils/defaultCategories";
import { sendPasswordResetEmail, sendVerificationCodeEmail } from "../services/email";
import { redisConnection } from "../queues/redisConnection";
import { claimOnce } from "../queues/dedupe";
import { rateLimit, emailFromBody } from "../middleware/rateLimit";

export const authRouter = Router();

function signToken(userId: string) {
  // env.JWT_EXPIRES_IN viene tipado como `string` genérico (Zod), pero
  // @types/jsonwebtoken exige el tipo literal StringValue (ej. "7d", "2h").
  // El valor en runtime siempre es válido (lo validamos nosotros vía .env),
  // así que el cast es seguro — no hay forma de tipar un string arbitrario
  // de entorno como ese literal sin esto.
  const options: jwt.SignOptions = { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] };
  return jwt.sign({ sub: userId }, env.JWT_SECRET, options);
}

// Sin código de país asumimos Perú (+51), ya que es el mercado actual de
// Gastia. Deja cualquier otro "+" tal cual venga (usuarios de otros países).
function normalizePhoneNumber(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, "");
  const withCountryCode = cleaned.startsWith("+") ? cleaned : `+51${cleaned}`;
  return withCountryCode;
}

// ---- Verificación del correo (código de 6 dígitos, vence en 15 min, 5 intentos) ----
const VERIFY_TTL_S = 15 * 60;
const VERIFY_MAX_ATTEMPTS = 5;
const verifyKey = (userId: string) => `emailverify:${userId}`;
const hashCode = (userId: string, code: string) =>
  crypto.createHash("sha256").update(`${userId}|${code}|${env.JWT_SECRET}`).digest("hex");

/** Genera y envía un código nuevo. Un envío por minuto por cuenta; devuelve false si aún está en espera. */
async function issueEmailCode(user: { id: string; name: string; email: string }): Promise<boolean> {
  if (!(await claimOnce(`emailverify:cool:${user.id}`, 60))) return false;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await redisConnection.set(verifyKey(user.id), JSON.stringify({ hash: hashCode(user.id, code), attempts: 0 }), "EX", VERIFY_TTL_S);
  const ok = await sendVerificationCodeEmail(user.email, user.name, code);
  if (!ok) throw new AppError("No pudimos enviar el código a tu correo. Revisa que esté bien escrito e inténtalo de nuevo.", 502);
  return true;
}

const PHONE_REGEX = /^\+\d{8,15}$/;

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  // El celular ya no se pide al registrarse: se vincula después, desde Configuración (plan Pro).
  phoneNumber: z.string().min(6).optional().or(z.literal("")),
  // Mascota elegida en /empezar. Gratis solo admite perro, gato o ninguna; el resto se desbloquea con Pro.
  petType: z.enum(["dog", "cat", "none"]).optional(),
  petName: z.string().trim().max(14).optional(),
});

authRouter.post(
  "/register",
  rateLimit({ name: "register", windowMs: 60 * 60 * 1000, max: 10 }),
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 422);
    const { name, email, password } = parsed.data;

    let phoneNumber: string | null = null;
    if (parsed.data.phoneNumber) {
      phoneNumber = normalizePhoneNumber(parsed.data.phoneNumber);
      if (!PHONE_REGEX.test(phoneNumber)) {
        throw new AppError("El número de WhatsApp no es válido. Inclúyelo con código de país, ej: +51987654321", 422);
      }
    }

    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail && existingEmail.emailVerifiedAt !== null) throw new AppError("Ya existe una cuenta con ese correo", 409);

    // Cuenta que nunca se verificó (alguien tecleó este correo y no lo confirmó): se reemplaza con los datos
    // nuevos y se reenvía el código. Así nadie "se queda" con el correo de otra persona sin demostrar que es suyo.
    if (existingEmail) {
      const passwordHash = await bcrypt.hash(password, 12);
      await prisma.user.update({
        where: { id: existingEmail.id },
        data: {
          name,
          passwordHash,
          ...(parsed.data.petType ? { petType: parsed.data.petType } : {}),
          ...(parsed.data.petName ? { petName: parsed.data.petName } : {}),
        },
      });
      await issueEmailCode({ id: existingEmail.id, name, email: existingEmail.email });
      return res.status(201).json({ needsVerification: true, email: existingEmail.email });
    }

    const existingPhone = phoneNumber ? await prisma.user.findUnique({ where: { phoneNumber } }) : null;
    if (existingPhone) throw new AppError("Ya existe una cuenta con ese número de WhatsApp", 409);

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        phoneNumber,
        ...(parsed.data.petType ? { petType: parsed.data.petType } : {}),
        ...(parsed.data.petName ? { petName: parsed.data.petName } : {}),
        onboarding: { create: {} },
        categories: {
          createMany: {
            data: ALL_DEFAULT_CATEGORIES.map((c) => ({ ...c, isDefault: true })),
          },
        },
      },
    });

    // Sin sesión hasta verificar el correo con el código que se envía ahora.
    await issueEmailCode({ id: user.id, name: user.name, email: user.email });
    res.status(201).json({ needsVerification: true, email: user.email });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  rateLimit({ name: "login-ip", windowMs: 15 * 60 * 1000, max: 40 }),
  rateLimit({ name: "login-email", windowMs: 15 * 60 * 1000, max: 10, keyExtra: emailFromBody }),
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("Credenciales inválidas", 422);
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash) throw new AppError("Correo o contraseña incorrectos", 401);

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new AppError("Correo o contraseña incorrectos", 401);

    // === null (no solo falsy): con el cliente de Prisma sin regenerar el campo no existe y no se bloquea a nadie.
    if (user.emailVerifiedAt === null) {
      throw new AppError("Falta verificar tu correo. Te enviamos un código para activar tu cuenta.", 403, "EMAIL_NOT_VERIFIED");
    }

    const token = signToken(user.id);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  })
);

// ------------------------------------------------------------
// VERIFICAR CORREO
// ------------------------------------------------------------

const verifyEmailSchema = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/, "El código tiene 6 dígitos") });

authRouter.post(
  "/verify-email",
  rateLimit({ name: "verify-ip", windowMs: 15 * 60 * 1000, max: 30 }),
  rateLimit({ name: "verify-email", windowMs: 15 * 60 * 1000, max: 10, keyExtra: emailFromBody }),
  asyncHandler(async (req, res) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user) throw new AppError("El código no es válido o venció. Pide uno nuevo.", 410);
    if (user.emailVerifiedAt !== null && user.emailVerifiedAt !== undefined) throw new AppError("Este correo ya está verificado. Inicia sesión.", 409);

    const raw = await redisConnection.get(verifyKey(user.id));
    if (!raw) throw new AppError("El código no es válido o venció. Pide uno nuevo.", 410);
    const st = JSON.parse(raw) as { hash: string; attempts: number };
    if (st.attempts >= VERIFY_MAX_ATTEMPTS) {
      await redisConnection.del(verifyKey(user.id));
      throw new AppError("Demasiados intentos. Pide un código nuevo.", 429);
    }
    if (hashCode(user.id, parsed.data.code) !== st.hash) {
      st.attempts += 1;
      const ttl = await redisConnection.ttl(verifyKey(user.id));
      await redisConnection.set(verifyKey(user.id), JSON.stringify(st), "EX", Math.max(ttl, 1));
      throw new AppError(`Código incorrecto. Te quedan ${Math.max(VERIFY_MAX_ATTEMPTS - st.attempts, 0)} intento(s).`, 422);
    }
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    await redisConnection.del(verifyKey(user.id));
    res.json({ token: signToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
  })
);

authRouter.post(
  "/resend-verification",
  rateLimit({ name: "resend-ip", windowMs: 60 * 60 * 1000, max: 15 }),
  rateLimit({ name: "resend-email", windowMs: 60 * 60 * 1000, max: 5, keyExtra: emailFromBody }),
  asyncHandler(async (req, res) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) throw new AppError("Correo inválido", 422);
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    // Respuesta igual exista o no la cuenta, para no revelar qué correos están registrados.
    if (user && user.emailVerifiedAt === null) await issueEmailCode({ id: user.id, name: user.name, email: user.email });
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------
// RECUPERAR CONTRASEÑA
// ------------------------------------------------------------

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

function hashResetToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

authRouter.post(
  "/forgot-password",
  rateLimit({ name: "forgot", windowMs: 60 * 60 * 1000, max: 8 }),
  rateLimit({ name: "forgot-email", windowMs: 60 * 60 * 1000, max: 3, keyExtra: emailFromBody }),
  asyncHandler(async (req, res) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("Ingresa un correo válido", 422);
    const { email } = parsed.data;

    // Respuesta genérica siempre, exista o no la cuenta — así no se puede
    // usar este endpoint para adivinar qué correos están registrados.
    const genericMessage = "Si el correo existe en Gastia, te enviamos un enlace para restablecer tu contraseña.";

    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetPasswordTokenHash: hashResetToken(rawToken),
          resetPasswordExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });

      const resetUrl = `${env.APP_BASE_URL}/restablecer?token=${rawToken}`;
      try {
        await sendPasswordResetEmail(user.email, user.name, resetUrl);
      } catch (err) {
        // No delatamos el error al usuario (mismo mensaje genérico) — queda
        // en el log del backend para que se pueda revisar/reintentar.
        console.error("Error enviando correo de recuperación:", err);
      }
    }

    res.json({ message: genericMessage });
  })
);

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

authRouter.post(
  "/reset-password",
  rateLimit({ name: "reset", windowMs: 60 * 60 * 1000, max: 15 }),
  asyncHandler(async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 422);
    const { token, password } = parsed.data;

    const tokenHash = hashResetToken(token);
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordTokenHash: tokenHash,
        resetPasswordExpiresAt: { gt: new Date() },
      },
    });
    if (!user) throw new AppError("El enlace no es válido o ya expiró. Solicita uno nuevo.", 400);

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetPasswordTokenHash: null,
        resetPasswordExpiresAt: null,
        // Entrar con el enlace enviado al correo demuestra que es suyo.
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      },
    });

    // Dejamos al usuario con sesión iniciada de una vez, para no hacerlo
    // pasar otra vez por el login después de haber cambiado su contraseña.
    const authToken = signToken(user.id);
    res.json({ token: authToken, user: { id: user.id, name: user.name, email: user.email } });
  })
);