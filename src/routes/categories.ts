import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";

export const categoriesRouter = Router();

categoriesRouter.use(requireAuth);

categoriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const categories = await prisma.category.findMany({
      where: { userId: req.userId, isArchived: false },
      orderBy: { name: "asc" },
    });
    res.json(categories);
  })
);

// Rojo por defecto para categorías nuevas que no traigan color explícito —
// las 9 categorías base (ver src/utils/defaultCategories.ts) no usan rojo
// en ningún tono, así una personalizada se distingue de un vistazo. El
// dashboard hoy siempre manda su propio colorHex (ver SWATCH_PALETTE en
// public/index.html, también en tonos rojos), así que esto es la red de
// seguridad para cualquier otro cliente que cree una categoría sin
// especificar color (ej. un futuro flujo por WhatsApp).
const DEFAULT_CUSTOM_CATEGORY_COLOR = "#E53935";

const createCategorySchema = z.object({
  name: z.string().min(1).max(50),
  icon: z.string().optional(),
  colorHex: z.string().optional(),
});

categoriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 422);
    }

    // El nombre es único por usuario (userId, name) — eliminar una categoría
    // es un soft-delete (isArchived), así que su nombre sigue "ocupado". Si
    // existe una archivada con el mismo nombre, se reactiva en vez de
    // intentar crear una fila nueva (que chocaría con ese índice único y
    // daría un 500 genérico).
    const existing = await prisma.category.findFirst({
      where: { userId: req.userId, name: parsed.data.name },
    });

    if (existing) {
      if (!existing.isArchived) {
        throw new AppError("Ya tienes una categoría con ese nombre", 409);
      }
      const reactivated = await prisma.category.update({
        where: { id: existing.id },
        data: {
          isArchived: false,
          icon: parsed.data.icon ?? existing.icon,
          colorHex: parsed.data.colorHex ?? existing.colorHex,
        },
      });
      res.status(201).json(reactivated);
      return;
    }

    const category = await prisma.category.create({
      data: { ...parsed.data, colorHex: parsed.data.colorHex ?? DEFAULT_CUSTOM_CATEGORY_COLOR, userId: req.userId! },
    });
    res.status(201).json(category);
  })
);

categoriesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const category = await prisma.category.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!category) throw new AppError("Categoría no encontrada", 404);

    // Antes de archivarla, reasignamos sus transacciones a "Otros comercios"
    // (una de las categorías base) — así no quedan huérfanas ni referenciando
    // una categoría archivada. Aplica sin importar por dónde se elimine
    // (dashboard u otro camino futuro), porque vive acá en la ruta/servicio,
    // no en el frontend.
    const fallbackCategory = await prisma.category.findFirst({
      where: { userId: req.userId, name: "Otros comercios", isArchived: false },
    });
    if (!fallbackCategory) {
      throw new AppError(
        'No se encontró la categoría "Otros comercios" para reasignar sus movimientos. No se eliminó nada — contacta soporte.',
        500
      );
    }

    if (fallbackCategory.id !== category.id) {
      await prisma.transaction.updateMany({
        where: { userId: req.userId, categoryId: category.id },
        data: { categoryId: fallbackCategory.id },
      });
    }

    await prisma.category.update({
      where: { id: category.id },
      data: { isArchived: true },
    });
    res.status(204).send();
  })
);