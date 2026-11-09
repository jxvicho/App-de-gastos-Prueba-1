import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  statusCode: number;
  /** Código opcional para que el dashboard reconozca el caso (ej. ACCESS_RESTRICTED). */
  code?: string;
  constructor(message: string, statusCode = 400, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
  }

  if (err instanceof ZodError) {
    return res.status(422).json({ error: err.issues[0]?.message || "Datos inválidos" });
  }

  console.error("Error no controlado:", err);
  return res.status(500).json({ error: "Error interno del servidor" });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: "Ruta no encontrada" });
}
