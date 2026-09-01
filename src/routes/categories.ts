import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";

export const categoriesRouter = Router();

categoriesRouter.use(requireAuth);

categoriesRouter.get("/", async (req, res) => {
  const categories = await prisma.category.findMany({
    where: { userId: req.userId, isArchived: false },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

const createCategorySchema = z.object({
  name: z.string().min(1).max(50),
  icon: z.string().optional(),
  colorHex: z.string().optional(),
});

categoriesRouter.post("/", async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues[0].message, 422);
  }

  const category = await prisma.category.create({
    data: { ...parsed.data, userId: req.userId! },
  });
  res.status(201).json(category);
});

categoriesRouter.delete("/:id", async (req, res) => {
  const category = await prisma.category.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!category) throw new AppError("Categoría no encontrada", 404);

  await prisma.category.update({
    where: { id: category.id },
    data: { isArchived: true },
  });
  res.status(204).send();
});
