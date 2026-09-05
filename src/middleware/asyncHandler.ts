import { NextFunction, Request, Response } from "express";

/**
 * Express 4 NO captura automáticamente los errores lanzados (throw) dentro
 * de un route handler `async`. Si no envolvemos cada handler con esto, un
 * error (ej. "contraseña incorrecta") deja la conexión colgada en vez de
 * devolver un JSON claro — exactamente el bug que causaba "Ocurrió un error
 * inesperado" en el dashboard.
 *
 * Uso: router.post("/ruta", asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}