import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { env } from "./config/env";
import { apiRouter } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { emailSyncWorker } from "./queues/emailSyncWorker";
import { scheduleEmailSyncRepeatable } from "./queues/emailSyncQueue";
import { weeklyReportWorker } from "./queues/weeklyReportWorker";
import { scheduleWeeklyReportRepeatable } from "./queues/weeklyReportQueue";
import { keepDatabaseAwake } from "./config/keepAlive";

const app = express();

// Helmet con la CSP relajada lo justo para permitir Google Fonts en el dashboard
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      },
    },
  })
);
app.use(cors({ origin: env.DASHBOARD_BASE_URL, credentials: true }));
app.use(
  express.json({
    // Guardamos el buffer crudo del body: el webhook de WhatsApp firma el
    // payload exacto que Meta envía, y validar contra el JSON re-serializado
    // por Express (distinto orden de keys/espacios) rompería la firma HMAC.
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  })
);

app.use("/api", apiRouter);

// Dashboard estático (Fase "visual" — habla con la misma API de arriba)
app.use(express.static(path.join(__dirname, "..", "public")));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use("/api", notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`✅ Backend corriendo en ${env.APP_BASE_URL} (puerto ${env.PORT})`);
  console.log(`🖥️  Dashboard disponible en la misma URL`);
});

const KEEP_ALIVE_INTERVAL_MS = 180_000; // 3 minutos, menor al auto-suspend de Neon (~5 min)
setInterval(() => {
  keepDatabaseAwake().catch((err) => {
    console.error("❌ Error en el keep-alive de base de datos:", err);
  });
}, KEEP_ALIVE_INTERVAL_MS);
console.log("🔄 Keep-alive de base de datos activo");

scheduleEmailSyncRepeatable().catch((err) => {
  console.error("❌ No se pudo programar la sincronización de correo:", err);
});
console.log("📬 Worker de sincronización de correo activo");
void emailSyncWorker;

scheduleWeeklyReportRepeatable().catch((err) => {
  console.error("❌ No se pudo programar el reporte semanal:", err);
});
console.log("📊 Worker de reporte semanal activo");
void weeklyReportWorker;