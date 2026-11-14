-- Nota libre del usuario para identificar un pago fijo (ej. "alquiler del depa")
ALTER TABLE "recurring_payments" ADD COLUMN "note" VARCHAR(80);
