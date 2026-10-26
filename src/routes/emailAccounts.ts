import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import { encrypt } from "../utils/crypto";
import { getMicrosoftAuthUrl, exchangeMicrosoftCode } from "../services/microsoftOAuth";
import { getGoogleAuthUrl, exchangeGoogleCode, isGoogleConfigured } from "../services/googleOAuth";

export const emailAccountsRouter = Router();

/** Máximo de correos conectados (activos) por usuario, en cualquier combinación Gmail/Outlook, para todos los planes. */
export const MAX_EMAIL_ACCOUNTS = 2;
const LIMIT_MESSAGE = `Puedes conectar hasta ${MAX_EMAIL_ACCOUNTS} correos. Desconecta uno para agregar otro.`;

/**
 * ¿Puede el usuario conectar este correo? Siempre si ya está activo (reconectar/renovar permisos);
 * si es nuevo (o estaba desconectado), solo si le queda cupo. Sin email (antes del OAuth) solo mira el cupo.
 */
async function canConnectEmail(userId: string, emailAddress?: string): Promise<boolean> {
  if (emailAddress) {
    const existing = await prisma.emailAccount.findUnique({
      where: { userId_emailAddress: { userId, emailAddress } },
      select: { isActive: true },
    });
    if (existing?.isActive) return true;
  }
  const active = await prisma.emailAccount.count({ where: { userId, isActive: true } });
  return active < MAX_EMAIL_ACCOUNTS;
}

emailAccountsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const accounts = await prisma.emailAccount.findMany({
      where: { userId: req.userId, isActive: true },
      // Nunca devolver accessToken/refreshToken al navegador.
      select: {
        id: true,
        provider: true,
        emailAddress: true,
        isActive: true,
        lastSyncedAt: true,
        createdAt: true,
        bankSenders: true,
      },
    });
    res.json(accounts);
  })
);

const selectBanksSchema = z.object({
  bankKeys: z.array(z.string()).min(1),
});

emailAccountsRouter.post(
  "/:id/banks",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = selectBanksSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("bankKeys debe ser un array con al menos un banco", 422);

    const account = await prisma.emailAccount.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!account) throw new AppError("Cuenta de correo no encontrada", 404);

    const catalogEntries = await prisma.bankCatalog.findMany({
      where: { bankKey: { in: parsed.data.bankKeys }, isActive: true },
    });
    if (catalogEntries.length === 0) throw new AppError("Ninguno de los bancos indicados existe", 422);

    await prisma.$transaction([
      prisma.bankSender.deleteMany({
        where: { emailAccountId: account.id, bankKey: { notIn: parsed.data.bankKeys } },
      }),
      ...catalogEntries.map((bank) =>
        prisma.bankSender.upsert({
          where: { emailAccountId_bankKey: { emailAccountId: account.id, bankKey: bank.bankKey } },
          update: { senderEmails: bank.senderEmails, displayName: bank.displayName },
          create: {
            emailAccountId: account.id,
            bankKey: bank.bankKey,
            displayName: bank.displayName,
            senderEmails: bank.senderEmails,
          },
        })
      ),
    ]);

    await prisma.onboardingState.update({
      where: { userId: req.userId! },
      data: { banksSelected: true, emailLinked: true },
    });

    const updated = await prisma.emailAccount.findUnique({
      where: { id: account.id },
      include: { bankSenders: true },
    });
    res.json(updated);
  })
);

emailAccountsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = await prisma.emailAccount.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!account) throw new AppError("Cuenta de correo no encontrada", 404);

    await prisma.emailAccount.update({ where: { id: account.id }, data: { isActive: false } });
    res.status(204).send();
  })
);

emailAccountsRouter.get(
  "/auth/microsoft",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Con el cupo lleno no se inicia otra conexión (el callback también lo valida).
    if (!(await canConnectEmail(req.userId!)) ) throw new AppError(LIMIT_MESSAGE, 409);
    const state = jwt.sign({ sub: req.userId }, env.JWT_SECRET, { expiresIn: "10m" });
    const url = await getMicrosoftAuthUrl(state);
    res.json({ url });
  })
);

emailAccountsRouter.get(
  "/auth/microsoft/callback",
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (error) {
      return res.redirect(`${env.APP_BASE_URL}/?email_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) throw new AppError("Faltan parámetros de Microsoft (code/state)", 400);

    let userId: string;
    try {
      const payload = jwt.verify(state, env.JWT_SECRET) as { sub: string };
      userId = payload.sub;
    } catch {
      throw new AppError("El enlace de conexión expiró, intenta conectar de nuevo", 400);
    }

    const tokens = await exchangeMicrosoftCode(code);
    if (!(await canConnectEmail(userId, tokens.email))) {
      return res.redirect(`${env.APP_BASE_URL}/?email_error=${encodeURIComponent("limit")}`);
    }

    await prisma.emailAccount.upsert({
      where: { userId_emailAddress: { userId, emailAddress: tokens.email } },
      update: {
        provider: "OUTLOOK",
        accessToken: encrypt(JSON.stringify({ homeAccountId: tokens.homeAccountId })),
        refreshToken: encrypt(tokens.serializedCache),
        tokenExpiresAt: tokens.expiresOn,
        isActive: true,
      },
      create: {
        userId,
        provider: "OUTLOOK",
        emailAddress: tokens.email,
        accessToken: encrypt(JSON.stringify({ homeAccountId: tokens.homeAccountId })),
        refreshToken: encrypt(tokens.serializedCache),
        tokenExpiresAt: tokens.expiresOn,
      },
    });

    res.redirect(`${env.APP_BASE_URL}/?email_connected=1`);
  })
);

emailAccountsRouter.get(
  "/auth/google",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isGoogleConfigured()) {
      throw new AppError("La conexión con Gmail aún no está configurada en el servidor", 503);
    }
    if (!(await canConnectEmail(req.userId!))) throw new AppError(LIMIT_MESSAGE, 409);
    const state = jwt.sign({ sub: req.userId }, env.JWT_SECRET, { expiresIn: "10m" });
    res.json({ url: getGoogleAuthUrl(state) });
  })
);

emailAccountsRouter.get(
  "/auth/google/callback",
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (error) {
      return res.redirect(`${env.APP_BASE_URL}/?email_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) throw new AppError("Faltan parámetros de Google (code/state)", 400);

    let userId: string;
    try {
      const payload = jwt.verify(state, env.JWT_SECRET) as { sub: string };
      userId = payload.sub;
    } catch {
      throw new AppError("El enlace de conexión expiró, intenta conectar de nuevo", 400);
    }

    const tokens = await exchangeGoogleCode(code);
    if (!(await canConnectEmail(userId, tokens.email))) {
      return res.redirect(`${env.APP_BASE_URL}/?email_error=${encodeURIComponent("limit")}`);
    }

    await prisma.emailAccount.upsert({
      where: { userId_emailAddress: { userId, emailAddress: tokens.email } },
      update: {
        provider: "GMAIL",
        accessToken: encrypt(tokens.accessToken),
        refreshToken: encrypt(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
        isActive: true,
      },
      create: {
        userId,
        provider: "GMAIL",
        emailAddress: tokens.email,
        accessToken: encrypt(tokens.accessToken),
        refreshToken: encrypt(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
      },
    });

    res.redirect(`${env.APP_BASE_URL}/?email_connected=1`);
  })
);
