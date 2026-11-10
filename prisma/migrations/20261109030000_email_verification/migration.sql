-- Verificación del correo de registro. Las cuentas que ya existen quedan como verificadas.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
UPDATE "User" SET "emailVerifiedAt" = now();
