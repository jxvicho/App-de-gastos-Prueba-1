import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { env } from "./config/env";
import { apiRouter } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { emailSyncWorker } from "./queues/emailSyncWorker";
import { scheduleEmailSyncRepeatable } from "./queues/emailSyncQueue";

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
app.use(express.json());

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

scheduleEmailSyncRepeatable().catch((err) => {
  console.error("❌ No se pudo programar la sincronización de correo:", err);
});
console.log("📬 Worker de sincronización de correo activo");
void emailSyncWorker;