import { Router } from "express";
import { prisma } from "../config/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";

export const banksRouter = Router();

banksRouter.use(requireAuth);

banksRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const banks = await prisma.bankCatalog.findMany({
      where: { isActive: true },
      orderBy: { displayName: "asc" },
    });
    res.json(banks);
  })
);
