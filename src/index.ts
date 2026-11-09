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
import { dailyReportWorker } from "./queues/dailyReportWorker";
import { scheduleDailyReportRepeatable } from "./queues/dailyReportQueue";
import { keepDatabaseAwake } from "./config/keepAlive";
import { sendPreChargeNotices } from "./services/billing";
import { rateLimit } from "./middleware/rateLimit";

const app = express();

// Detrás de un proxy (Caddy/Nginx/ngrok) pon TRUST_PROXY=1 para que req.ip sea la IP real del cliente.
if (env.TRUST_PROXY > 0) app.set("trust proxy", env.TRUST_PROXY);

// Helmet con la CSP relajada lo justo para permitir Google Fonts en el dashboard
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        // Logos de bancos (ícono oficial del sitio de cada banco) en Configuración
        "img-src": ["'self'", "data:", "https://www.google.com", "https://*.gstatic.com"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://*.culqi.com"],
        // Culqi Checkout (formulario de tarjeta de la suscripción): script, iframe y llamadas a su API.
        "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://js.culqi.com", "https://*.culqi.com"],
        "frame-src": ["'self'", "https://*.culqi.com", "https://js.culqi.com"],
        "connect-src": ["'self'", "https://*.culqi.com", "https://api.culqi.com"],
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

// Tope general por IP. Los webhooks (Meta, Culqi) quedan fuera: llegan de pocas IPs y en ráfagas.
const generalLimiter = rateLimit({ name: "api", windowMs: 60 * 1000, max: 600 });
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/whatsapp/webhook") || req.path.startsWith("/billing/culqi-webhook")) return next();
  return generalLimiter(req, res, next);
});

app.use("/api", apiRouter);

// Páginas de autenticación — rutas propias, con URL real y compartible
// (necesario para cuando la landing pública de Gastia tenga botones
// "Ingresar" / "Registrarse" apuntando directo a estas URLs).
app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});
app.get("/registro", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "registro.html"));
});
app.get("/recuperar", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "forgot-password.html"));
});
app.get("/restablecer", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "reset-password.html"));
});

// Web pública: landing en "/", onboarding en "/empezar" y el dashboard (SPA) en "/app".
const publicDir = path.join(__dirname, "..", "public");
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "landing.html")));
app.get("/empezar", (_req, res) => res.sendFile(path.join(publicDir, "empezar.html")));
app.get(/^\/app(\/.*)?$/, (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
// index:false para que "/" no sirva index.html (el dashboard) por defecto.
app.use(express.static(publicDir, { index: false }));
// Cualquier otra ruta que no sea API vuelve a la landing.
app.get(/^(?!\/api).*/, (_req, res) => res.redirect("/"));

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

// Aviso por correo, 2 días antes, del primer cobro del plan anual (solo con pagos activos).
if (env.PAYMENTS_ENABLED) {
  const runPreCharge = () => sendPreChargeNotices().catch((err) => console.error("❌ Error enviando avisos previos de cobro:", err));
  setTimeout(runPreCharge, 60_000);
  setInterval(runPreCharge, 3_600_000);
}

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

scheduleDailyReportRepeatable().catch((err) => {
  console.error("❌ No se pudo programar el reporte diario:", err);
});
console.log("📅 Worker de reporte diario activo");
void dailyReportWorker;