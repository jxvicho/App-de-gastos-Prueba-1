import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "./errorHandler";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminEmail?: string;
    }
  }
}

function adminEmails(): string[] {
  return env.ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Solo deja pasar a los correos listados en ADMIN_EMAILS. Va DESPUÉS de requireAuth.
 * Responde 403 sin detalles para cualquier otro usuario (no revela que existe un panel).
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.userId) return next(new AppError("No autorizado", 401));
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true } });
    if (!user || !adminEmails().includes(user.email.toLowerCase())) {
      return next(new AppError("No tienes acceso a esta sección", 403));
    }
    req.adminEmail = user.email;
    next();
  } catch (err) {
    next(err);
  }
}
