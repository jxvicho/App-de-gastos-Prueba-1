-- Aditiva: historial unificado entre WhatsApp y chat web. Las filas existentes quedan como WHATSAPP.
ALTER TABLE "whatsapp_messages" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'WHATSAPP';
ALTER TABLE "whatsapp_messages" ADD COLUMN "buttons" JSONB;
