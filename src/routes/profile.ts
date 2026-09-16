import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";

export const profileRouter = Router();

profileRouter.use(requireAuth);

profileRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId },
      select: { petType: true, petName: true },
    });
    res.json(user);
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
