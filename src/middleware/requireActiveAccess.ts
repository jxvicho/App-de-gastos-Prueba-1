import { NextFunction, Request, Response } from "express";
import { isAccessRestricted } from "../services/billing";
import { AppError } from "./errorHandler";

/**
 * Modo solo lectura por cobro pendiente (desde el 3.er intento fallido): las consultas (GET) siguen
 * funcionando, pero crear/editar/borrar se bloquea con 402 y el código ACCESS_RESTRICTED.
 * Va DESPUÉS de requireAuth (necesita req.userId).
 */
export async function requireActiveAccess(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  try {
    if (req.userId && (await isAccessRestricted(req.userId))) {
      return next(
        new AppError(
          "Tu acceso está en modo solo lectura por un pago pendiente. Actualiza tu tarjeta en Configuración > Plan y suscripción para seguir registrando.",
          402,
          "ACCESS_RESTRICTED"
        )
      );
    }
    next();
  } catch (err) {
    // Si la base falla no bloqueamos al usuario.
    console.error("No se pudo evaluar el acceso por suscripción (se permite):", err);
    next();
  }
}
