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

export const emailAccountsRouter = Router();

emailAccountsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const accounts = await prisma.emailAccount.findMany({
      where: { userId: req.userId, isActive: true },
      include: { bankSenders: true },
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

    await prisma.$transaction(
      catalogEntries.map((bank) =>
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
      )
    );

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
