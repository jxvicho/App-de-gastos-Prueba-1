-- Verificación del correo de registro. Las cuentas que ya existen quedan como verificadas.
ALTER TABLE users ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
UPDATE users SET "emailVerifiedAt" = now();
