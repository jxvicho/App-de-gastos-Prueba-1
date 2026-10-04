import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { asyncHandler } from "../middleware/asyncHandler";
import { DEFAULT_CATEGORIES } from "../utils/defaultCategories";
import { sendPasswordResetEmail } from "../services/email";

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

const PHONE_REGEX = /^\+\d{8,15}$/;

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  phoneNumber: z.string().min(6),
});

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 422);
    const { name, email, password } = parsed.data;

    const phoneNumber = normalizePhoneNumber(parsed.data.phoneNumber);
    if (!PHONE_REGEX.test(phoneNumber)) {
      throw new AppError("El número de WhatsApp no es válido. Inclúyelo con código de país, ej: +51987654321", 422);
    }

    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) throw new AppError("Ya existe una cuenta con ese correo", 409);

    const existingPhone = await prisma.user.findUnique({ where: { phoneNumber } });
    if (existingPhone) throw new AppError("Ya existe una cuenta con ese número de WhatsApp", 409);

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        phoneNumber,
        onboarding: { create: {} },
        categories: {
          createMany: {
            data: DEFAULT_CATEGORIES.map((c) => ({ ...c, isDefault: true })),
          },
        },
      },
    });

    const token = signToken(user.id);
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("Credenciales inválidas", 422);
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash) throw new AppError("Correo o contraseña incorrectos", 401);

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new AppError("Correo o contraseña incorrectos", 401);

    const token = signToken(user.id);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
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
      },
    });

    // Dejamos al usuario con sesión iniciada de una vez, para no hacerlo
    // pasar otra vez por el login después de haber cambiado su contraseña.
    const authToken = signToken(user.id);
    res.json({ token: authToken, user: { id: user.id, name: user.name, email: user.email } });
  })
);