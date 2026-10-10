import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import bcrypt from "bcryptjs";
import { getEffectivePlan } from "../services/plans";
import { PLAN_LABELS } from "../config/plans";

export const profileRouter = Router();

profileRouter.use(requireAuth);

profileRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId },
      select: {
        name: true,
        email: true,
        phoneNumber: true,
        timezone: true,
        petType: true,
        petName: true,
        autoRegister: true,
        whatsappOptIn: true,
        dailySummaryEnabled: true,
        dailySummaryHour: true,
        alertThreshold: true,
        plan: true,
        planOverride: true,
        planOverrideUntil: true,
        passwordHash: true,
      },
    });
    const eff = await getEffectivePlan(user);
    const isUnlimited = eff.plan === "UNLIMITED";
    // Solo el plan especial (UNLIMITED) puede apagar/encender estas dos funciones.
    // En los demás planes van activas "por defecto del plan".
    const { phoneNumber, passwordHash, plan: _p, planOverride: _o, planOverrideUntil: _u, alertThreshold, ...rest } = user;
    const whatsappPhone = phoneNumber
      ? `${phoneNumber.slice(0, 3)} ${phoneNumber.slice(3, 4)}•• ••• ${phoneNumber.slice(-3)}`
      : null;
    res.json({
      ...rest,
      whatsappPhone,
      hasPassword: !!passwordHash,
      alertThreshold: alertThreshold ? Number(alertThreshold) : null,
      plan: eff.plan,
      planLabel: PLAN_LABELS[eff.plan],
      features: {
        canToggleAutoRegister: isUnlimited,
        canToggleDailySummary: isUnlimited,
        autoRegisterOn: isUnlimited ? user.autoRegister : true,
        dailySummaryOn: isUnlimited ? user.dailySummaryEnabled : true,
        alerts: eff.plan === "PRO" || isUnlimited,
        fullChat: eff.plan !== "BASIC",
      },
    });
  })
);

const updateProfileSchema = z.object({
  name: z.string().trim().min(2, "El nombre es muy corto").max(60).optional(),
  alertThreshold: z.number().min(0).max(10_000_000).nullable().optional(),
});

// Datos que se pueden cambiar sin impacto grande en Gastia (el correo y el celular NO: son el login y el vínculo de WhatsApp).
profileRouter.patch(
  "/me",
  asyncHandler(async (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
    const { name, alertThreshold } = parsed.data;

    const data: { name?: string; alertThreshold?: number | null } = {};
    if (name !== undefined) data.name = name;
    if (alertThreshold !== undefined) {
      const current = await prisma.user.findUniqueOrThrow({
        where: { id: req.userId },
        select: { plan: true, planOverride: true, planOverrideUntil: true },
      });
      const eff = await getEffectivePlan(current);
      if (eff.plan === "BASIC") throw new AppError("Las alertas de gasto están disponibles en planes superiores", 403);
      data.alertThreshold = alertThreshold && alertThreshold > 0 ? alertThreshold : null;
    }
    const user = await prisma.user.update({ where: { id: req.userId }, data, select: { name: true } });
    res.json(user);
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "La nueva contraseña debe tener al menos 8 caracteres").max(100),
});

profileRouter.post(
  "/change-password",
  asyncHandler(async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { passwordHash: true } });
    if (user.passwordHash) {
      const ok = parsed.data.currentPassword ? await bcrypt.compare(parsed.data.currentPassword, user.passwordHash) : false;
      if (!ok) throw new AppError("La contraseña actual no es correcta", 403);
    }
    await prisma.user.update({ where: { id: req.userId }, data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12) } });
    res.json({ ok: true });
  })
);

const PET_TYPES = ["dog", "cat", "capybara", "pig", "none"] as const;
const setPetSchema = z.object({
  petType: z.enum(PET_TYPES),
  petName: z.string().trim().min(1).max(11).nullish(),
});

profileRouter.patch(
  "/pet",
  asyncHandler(async (req, res) => {
    const parsed = setPetSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos de mascota inválidos", 422);

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { petType: parsed.data.petType, petName: parsed.data.petName },
      select: { petType: true, petName: true },
    });
    res.json(user);
  })
);

const setAutoRegisterSchema = z.object({ enabled: z.boolean() });

profileRouter.patch(
  "/auto-register",
  asyncHandler(async (req, res) => {
    const parsed = setAutoRegisterSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("Indica si el registro automático está activo (enabled: true/false)", 422);

    const current = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId },
      select: { plan: true, planOverride: true, planOverrideUntil: true },
    });
    if ((await getEffectivePlan(current)).plan !== "UNLIMITED") {
      throw new AppError("El registro automático ya está activo para tu plan actual", 403);
    }
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { autoRegister: parsed.data.enabled },
      select: { autoRegister: true },
    });
    res.json(user);
  })
);

const setWhatsappPrefsSchema = z.object({
  whatsappOptIn: z.boolean().optional(), // consentimiento general para recibir mensajes
  dailySummaryEnabled: z.boolean().optional(), // solo plan especial (UNLIMITED)
  dailySummaryHour: z.number().int().min(0).max(23).optional(),
});

profileRouter.patch(
  "/whatsapp-prefs",
  asyncHandler(async (req, res) => {
    const parsed = setWhatsappPrefsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("Datos inválidos: whatsappOptIn, dailySummaryEnabled (true/false) y dailySummaryHour (0 a 23)", 422);

    if (parsed.data.dailySummaryEnabled !== undefined) {
      const current = await prisma.user.findUniqueOrThrow({
        where: { id: req.userId },
        select: { plan: true, planOverride: true, planOverrideUntil: true },
      });
      if ((await getEffectivePlan(current)).plan !== "UNLIMITED") {
        throw new AppError("El resumen diario ya está activo para tu plan actual", 403);
      }
    }
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: parsed.data,
      select: { whatsappOptIn: true, dailySummaryEnabled: true, dailySummaryHour: true },
    });
    res.json(user);
  })
);
