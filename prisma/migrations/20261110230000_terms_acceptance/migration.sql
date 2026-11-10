-- Constancia de que la persona aceptó los términos y la política de privacidad al crear su cuenta (fecha y versión).
-- Las cuentas anteriores quedan en NULL.
ALTER TABLE "users" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "termsVersion" TEXT;
