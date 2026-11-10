import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { env } from "../config/env";
import { rateLimit } from "../middleware/rateLimit";
import { redisConnection } from "../queues/redisConnection";
import { claimOnce } from "../queues/dedupe";
import { sendTemplateMessage } from "../services/whatsapp";
import { getEffectivePlan } from "../services/plans";
import { PLAN_LABELS, PLAN_FEATURES } from "../config/plans";

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
    // Pro y Unlimited eligen registro automático/manual y pueden apagar el resumen diario; Básico es manual y sin diario.
    const { phoneNumber, passwordHash, plan: _p, planOverride: _o, planOverrideUntil: _u, alertThreshold, ...rest } = user;
    const whatsappPhone = phoneNumber
      ? `${phoneNumber.slice(0, 3)} ${phoneNumber.slice(3, 4)}•• ••• ${phoneNumber.slice(-3)}`
      : null;
    const feats = PLAN_FEATURES[eff.plan];
    res.json({
      ...rest,
      // Gratis: sin WhatsApp (opt-in siempre apagado) y solo mascotas básicas; si tenía una premium, se muestra el perro.
      whatsappOptIn: feats.whatsapp ? user.whatsappOptIn : false,
      petType: !feats.premiumPets && (user.petType === "capybara" || user.petType === "pig") ? "dog" : user.petType,
      hasPhone: !!phoneNumber,
      whatsappPhone,
      hasPassword: !!passwordHash,
      alertThreshold: alertThreshold ? Number(alertThreshold) : null,
      plan: eff.plan,
      planLabel: PLAN_LABELS[eff.plan],
      features: {
        canToggleAutoRegister: PLAN_FEATURES[eff.plan].autoRegister,
        canToggleDailySummary: PLAN_FEATURES[eff.plan].dailySummary,
        canChangeDailyHour: false, // hora fija: 9:00 a. m. (Lima)
        autoRegisterOn: PLAN_FEATURES[eff.plan].autoRegister ? user.autoRegister : false,
        dailySummaryAvailable: PLAN_FEATURES[eff.plan].dailySummary,
        dailySummaryOn: PLAN_FEATURES[eff.plan].dailySummary ? user.dailySummaryEnabled : false,
        alerts: PLAN_FEATURES[eff.plan].alerts,
        fullChat: eff.plan !== "BASIC" && eff.plan !== "FREE",
        canCreateCategories: PLAN_FEATURES[eff.plan].createCategories,
        canConnectEmail: PLAN_FEATURES[eff.plan].emailSync,
        canUseWhatsapp: PLAN_FEATURES[eff.plan].whatsapp,
        webChatDailyCap: PLAN_FEATURES[eff.plan].webChatDailyCap,
        premiumPets: feats.premiumPets,
        limits: { recurring: feats.maxRecurring, goals: feats.maxGoals, debtsPerDirection: feats.maxDebtsPerDirection },
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
      if (!PLAN_FEATURES[eff.plan].alerts) throw new AppError("Las alertas de gasto están disponibles en planes superiores", 403);
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
    if (parsed.data.petType === "capybara" || parsed.data.petType === "pig") {
      const cur = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { plan: true, planOverride: true, planOverrideUntil: true } });
      if (!PLAN_FEATURES[(await getEffectivePlan(cur)).plan].premiumPets) {
        throw new AppError("El chancho y el capibara se desbloquean con el plan Pro. En Gratis puedes elegir perro, gato o ninguna.", 403, "PLAN_FEATURE");
      }
    }

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
    if (!PLAN_FEATURES[(await getEffectivePlan(current)).plan].autoRegister) {
      throw new AppError("Tu plan registra los movimientos de forma manual. Pasa al plan Pro para activar el registro automático.", 403);
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

    if (parsed.data.whatsappOptIn === true) {
      const cur = await prisma.user.findUniqueOrThrow({
        where: { id: req.userId },
        select: { plan: true, planOverride: true, planOverrideUntil: true, phoneNumber: true },
      });
      if (!PLAN_FEATURES[(await getEffectivePlan(cur)).plan].whatsapp) {
        throw new AppError("Recibir mensajes por WhatsApp es parte del plan Pro. En Gratis esta opción queda apagada.", 403, "PLAN_FEATURE");
      }
      if (!cur.phoneNumber) throw new AppError("Primero vincula tu número de WhatsApp en Configuración.", 409);
    }

    if (parsed.data.dailySummaryEnabled !== undefined || parsed.data.dailySummaryHour !== undefined) {
      const current = await prisma.user.findUniqueOrThrow({
        where: { id: req.userId },
        select: { plan: true, planOverride: true, planOverrideUntil: true },
      });
      const plan = (await getEffectivePlan(current)).plan;
      if (!PLAN_FEATURES[plan].dailySummary) {
        throw new AppError("El resumen diario está disponible desde el plan Pro", 403);
      }
    }
    // La hora del resumen diario es fija (9:00 a. m. Lima): se ignora cualquier valor enviado.
    const { dailySummaryHour: _ignoredHour, ...allowedData } = parsed.data;
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: allowedData,
      select: { whatsappOptIn: true, dailySummaryEnabled: true, dailySummaryHour: true },
    });
    res.json(user);
  })
);

const setPhoneSchema = z.object({ phoneNumber: z.string().min(6, "Escribe tu número de WhatsApp") });
const verifyPhoneSchema = z.object({ code: z.string().regex(/^\d{6}$/, "El código tiene 6 dígitos") });

const VERIFY_TTL_S = 10 * 60;
const VERIFY_MAX_ATTEMPTS = 5;
const verifyKey = (userId: string) => `phoneverify:${userId}`;
const hashCode = (userId: string, phone: string, code: string) =>
  crypto.createHash("sha256").update(`${userId}|${phone}|${code}|${env.JWT_SECRET}`).digest("hex");
const maskPhone = (p: string) => `${p.slice(0, 3)} ${p.slice(3, 4)}•• ••• ${p.slice(-3)}`;

async function assertWhatsappPlan(userId: string) {
  const cur = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, planOverride: true, planOverrideUntil: true, phoneNumber: true },
  });
  if (!PLAN_FEATURES[(await getEffectivePlan(cur)).plan].whatsapp) {
    throw new AppError("Vincular WhatsApp es parte del plan Pro.", 403, "PLAN_FEATURE");
  }
  return cur;
}

/** Paso 1: pide vincular un número. Se envía un código de 6 dígitos por WhatsApp a ese número. */
profileRouter.post(
  "/phone/request",
  rateLimit({ name: "phone-request", windowMs: 60 * 60 * 1000, max: 5, message: "Pediste demasiados códigos. Inténtalo en una hora." }),
  asyncHandler(async (req, res) => {
    const parsed = setPhoneSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Número inválido", 422);
    const cur = await assertWhatsappPlan(req.userId!);
    const cleaned = parsed.data.phoneNumber.replace(/[^\d+]/g, "");
    const phoneNumber = cleaned.startsWith("+") ? cleaned : `+51${cleaned}`;
    if (!/^\+\d{8,15}$/.test(phoneNumber)) {
      throw new AppError("El número de WhatsApp no es válido. Inclúyelo con código de país, ej: +51987654321", 422);
    }
    if (cur.phoneNumber === phoneNumber) throw new AppError("Ese número ya está vinculado a tu cuenta.", 409);
    const other = await prisma.user.findUnique({ where: { phoneNumber }, select: { id: true } });
    if (other && other.id !== req.userId) throw new AppError("Ya existe una cuenta con ese número de WhatsApp", 409);

    // Un código por número cada 60 s (evita que alguien use la app para spamear a un tercero).
    if (!(await claimOnce(`phoneverify:cool:${phoneNumber}`, 60))) {
      throw new AppError("Espera un minuto antes de pedir otro código.", 429);
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    await redisConnection.set(
      verifyKey(req.userId!),
      JSON.stringify({ phone: phoneNumber, hash: hashCode(req.userId!, phoneNumber, code), attempts: 0 }),
      "EX",
      VERIFY_TTL_S
    );

    const wamid = await sendTemplateMessage(phoneNumber.replace(/^\+/, ""), env.WHATSAPP_TEMPLATE_VERIFY, env.WHATSAPP_TEMPLATE_VERIFY_LANG, [code], {
      kind: "verification",
      urlButtonSuffix: code,
    });
    if (!wamid) {
      if (env.NODE_ENV !== "production") console.warn(`[verificación] Código para ${phoneNumber}: ${code} (no se pudo enviar por WhatsApp)`);
      else {
        await redisConnection.del(verifyKey(req.userId!));
        throw new AppError("No pudimos enviar el código por WhatsApp. Revisa el número e inténtalo de nuevo.", 502);
      }
    }
    res.json({ ok: true, phone: maskPhone(phoneNumber), expiresInSec: VERIFY_TTL_S });
  })
);

/** Paso 2: confirma el código recibido y recién entonces vincula el número. */
profileRouter.post(
  "/phone/verify",
  asyncHandler(async (req, res) => {
    const parsed = verifyPhoneSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Código inválido", 422);
    await assertWhatsappPlan(req.userId!);
    const raw = await redisConnection.get(verifyKey(req.userId!));
    if (!raw) throw new AppError("El código venció o no pediste uno. Solicita uno nuevo.", 410);
    const st = JSON.parse(raw) as { phone: string; hash: string; attempts: number };
    if (st.attempts >= VERIFY_MAX_ATTEMPTS) {
      await redisConnection.del(verifyKey(req.userId!));
      throw new AppError("Demasiados intentos. Solicita un código nuevo.", 429);
    }
    if (hashCode(req.userId!, st.phone, parsed.data.code) !== st.hash) {
      st.attempts += 1;
      const ttl = await redisConnection.ttl(verifyKey(req.userId!));
      await redisConnection.set(verifyKey(req.userId!), JSON.stringify(st), "EX", Math.max(ttl, 1));
      throw new AppError(`Código incorrecto. Te quedan ${Math.max(VERIFY_MAX_ATTEMPTS - st.attempts, 0)} intento(s).`, 422);
    }
    const other = await prisma.user.findUnique({ where: { phoneNumber: st.phone }, select: { id: true } });
    if (other && other.id !== req.userId) throw new AppError("Ya existe una cuenta con ese número de WhatsApp", 409);
    // Número nuevo: exige volver a aceptar los mensajes y reinicia la ventana de 24 h.
    await prisma.user.update({
      where: { id: req.userId },
      data: { phoneNumber: st.phone, whatsappOptIn: false, lastInboundAt: null },
    });
    await redisConnection.del(verifyKey(req.userId!));
    res.json({ ok: true, whatsappPhone: maskPhone(st.phone) });
  })
);
