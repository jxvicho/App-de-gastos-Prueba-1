import { NextFunction, Request, Response } from "express";

/**
 * Limitador de peticiones en memoria (sin dependencias). Cuenta las peticiones por clave
 * (IP, o IP + dato del body como el correo) dentro de una ventana y responde 429 al pasarse.
 * Suficiente para una sola instancia del backend; si algún día hay varias, moverlo a Redis.
 */
type Bucket = { count: number; resetAt: number };

interface Options {
  /** Nombre del limitador (solo para separar contadores). */
  name: string;
  windowMs: number;
  max: number;
  /** Clave extra además de la IP, p. ej. el correo del body. Si devuelve "" se usa solo la IP. */
  keyExtra?: (req: Request) => string;
  message?: string;
}

const buckets = new Map<string, Bucket>();

// Limpieza periódica para que el mapa no crezca sin fin.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000);
sweeper.unref();

export function rateLimit(opts: Options) {
  const message = opts.message ?? "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
  return (req: Request, res: Response, next: NextFunction) => {
    const extra = opts.keyExtra ? opts.keyExtra(req) : "";
    const key = `${opts.name}|${req.ip ?? "?"}|${extra}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > opts.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

/** Correo del body normalizado (para limitar intentos contra una misma cuenta). */
export function emailFromBody(req: Request): string {
  const e = (req.body as { email?: unknown } | undefined)?.email;
  return typeof e === "string" ? e.trim().toLowerCase().slice(0, 254) : "";
}
