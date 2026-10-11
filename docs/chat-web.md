# Chat web del dashboard

Misma lógica que el bot de WhatsApp (`handleIncomingMessage`), sin duplicarla.

- **Activar:** `WEB_CHAT_ENABLED=true` (y opcional `WEB_CHAT_DAILY_CAP=100`) en `.env`, luego `docker compose up --build -d`. Apagado por defecto: sin la bandera no aparece el botón 💬 y `/api/chat` responde 404.
- **Cómo funciona:** `runInWebChannel()` (AsyncLocalStorage en `src/services/whatsapp.ts`) captura las respuestas de `sendTextMessage`/`sendInteractiveButtons` en vez de llamar a Meta. No abre la ventana de 24 h, no cuenta contra el límite de mensajes del plan y no registra `OutboundMessage`.
- **Estado pendiente separado por canal** (`ChannelMap` en `whatsappBot.ts`).
- **Historial:** `whatsapp_messages.channel` (`WHATSAPP` | `WEB`). El chat web guarda ahí entrada y salida. El bot de WhatsApp todavía no escribe en esta tabla.
- **Tope diario** por usuario (Gemini tiene costo).
- **Fase 2:** `POST /api/chat/media` (imagen JPG/PNG/WebP ≤5 MB o nota de voz ≤2 MB, cuenta contra el tope diario). Botones 📎 y 🎤 en el panel; reutiliza `handleIncomingImage`/`handleIncomingAudio` con el archivo precargado (sin Meta).
- **Revertir:** volver a `feature/mascotas`; la migración `20261011080000_web_chat` solo agrega 2 columnas.
