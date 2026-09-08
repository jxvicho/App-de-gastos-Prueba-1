import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";

export const categoryRulesRouter = Router();

categoryRulesRouter.use(requireAuth);

categoryRulesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rules = await prisma.categoryRule.findMany({
      where: { userId: req.userId },
      include: { category: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(rules);
  })
);

const ruleTypeEnum = z.enum(["MERCHANT_CONTAINS", "AMOUNT_GREATER_THAN", "AMOUNT_LESS_THAN", "AMOUNT_EQUALS"]);

const createRuleSchema = z.object({
  type: ruleTypeEnum,
  value: z.string().min(1),
  categoryId: z.string().uuid(),
});

categoryRulesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createRuleSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 422);

    const category = await prisma.category.findFirst({
      where: { id: parsed.data.categoryId, userId: req.userId },
    });
    if (!category) throw new AppError("Categoría no encontrada", 404);

    if (parsed.data.type !== "MERCHANT_CONTAINS" && Number.isNaN(parseFloat(parsed.data.value))) {
      throw new AppError("El valor debe ser un número para reglas de monto", 422);
    }

    const rule = await prisma.categoryRule.create({
      data: {
        userId: req.userId!,
        type: parsed.data.type,
        value: parsed.data.value,
        categoryId: category.id,
        source: "DASHBOARD",
      },
      include: { category: true },
    });

    res.status(201).json(rule);
  })
);

// Acepta cualquier combinación de estos campos: el toggle de activo (como
// antes) y/o la edición del criterio/categoría desde el dashboard.
const updateRuleSchema = z
  .object({
    isActive: z.boolean().optional(),
    type: ruleTypeEnum.optional(),
    value: z.string().min(1).optional(),
    categoryId: z.string().uuid().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Nada para actualizar" });

categoryRulesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const parsed = updateRuleSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 422);

    const rule = await prisma.categoryRule.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!rule) throw new AppError("Regla no encontrada", 404);

    let categoryId: string | undefined;
    if (parsed.data.categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: parsed.data.categoryId, userId: req.userId },
      });
      if (!category) throw new AppError("Categoría no encontrada", 404);
      categoryId = category.id;
    }

    const effectiveType = parsed.data.type ?? rule.type;
    const effectiveValue = parsed.data.value ?? rule.value;
    if (effectiveType !== "MERCHANT_CONTAINS" && Number.isNaN(parseFloat(effectiveValue))) {
      throw new AppError("El valor debe ser un número para reglas de monto", 422);
    }

    const updated = await prisma.categoryRule.update({
      where: { id: rule.id },
      data: {
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
        ...(parsed.data.type ? { type: parsed.data.type } : {}),
        ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
        ...(categoryId ? { categoryId } : {}),
      },
      include: { category: true },
    });

    res.json(updated);
  })
);

categoryRulesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const rule = await prisma.categoryRule.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!rule) throw new AppError("Regla no encontrada", 404);

    await prisma.categoryRule.delete({ where: { id: rule.id } });
    res.status(204).send();
  })
);
