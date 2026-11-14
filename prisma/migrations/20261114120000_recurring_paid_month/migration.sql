-- Pago fijo marcado como pagado a mano en el mes indicado ("YYYY-MM", hora de Lima)
ALTER TABLE "recurring_payments" ADD COLUMN "paidMonth" TEXT;
