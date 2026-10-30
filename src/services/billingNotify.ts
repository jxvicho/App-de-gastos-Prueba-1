import { env } from "../config/env";
import { sendHtmlEmail } from "./email";
import { isWindowOpen, sendTemplateMessage, sendTextMessage } from "./whatsapp";

/**
 * Avisos de cobro (política definida el 30-oct-2026):
 *  - 1.er fallo: correo. 2.º fallo: correo + WhatsApp. 3.er fallo: se limita el acceso, correo + WhatsApp.
 *  - Cancelación tras agotar los reintentos: correo + WhatsApp.
 * WhatsApp fuera de la ventana de 24 h solo admite la plantilla aprobada (WHATSAPP_TEMPLATE_BILLING).
 */
export type BillingNoticeKind = "FAILED_1" | "FAILED_2" | "RESTRICTED" | "CANCELED_AUTO" | "RECOVERED" | "PRECHARGE_ANNUAL";

export interface NoticeUser {
  name: string;
  email: string;
  billingEmail?: string | null;
  phoneNumber: string | null;
  whatsappOptIn: boolean;
}

export interface NoticeExtra {
  amount?: string;
  date?: string;
}

const WHATSAPP_KINDS: BillingNoticeKind[] = ["FAILED_2", "RESTRICTED", "CANCELED_AUTO", "RECOVERED"];

function copy(kind: BillingNoticeKind, firstName: string, extra?: NoticeExtra): { subject: string; text: string; short: string } {
  switch (kind) {
    case "FAILED_1":
      return {
        subject: "No pudimos cobrar tu suscripción de Gastia",
        text: `Hola ${firstName}, no pudimos cobrar tu suscripción de Gastia. Volveremos a intentarlo automáticamente en los próximos días. Para evitar interrupciones, revisa que tu tarjeta tenga fondos y esté vigente, o actualízala en Configuración > Plan y suscripción.`,
        short: "no pudimos cobrar tu suscripción; volveremos a intentarlo. Revisa tu tarjeta en Configuración > Plan y suscripción",
      };
    case "FAILED_2":
      return {
        subject: "Segundo intento de cobro fallido en Gastia",
        text: `Hola ${firstName}, el segundo intento de cobro de tu suscripción de Gastia también falló. Si el siguiente falla, tu acceso pasará a modo solo lectura. Actualiza tu tarjeta en Configuración > Plan y suscripción para evitarlo.`,
        short: "el segundo intento de cobro falló; si falla otra vez tu acceso quedará en solo lectura. Actualiza tu tarjeta en Configuración > Plan y suscripción",
      };
    case "RESTRICTED":
      return {
        subject: "Tu acceso a Gastia está limitado por un pago pendiente",
        text: `Hola ${firstName}, tras tres intentos fallidos de cobro, tu acceso a Gastia quedó en modo solo lectura: puedes ver tus datos, pero no registrar movimientos ni usar el chat. No perdiste nada. Actualiza tu tarjeta en Configuración > Plan y suscripción y recuperarás el acceso completo al instante.`,
        short: "tu acceso quedó en solo lectura por un pago pendiente. Actualiza tu tarjeta en Configuración > Plan y suscripción para recuperarlo",
      };
    case "CANCELED_AUTO":
      return {
        subject: "Tu suscripción de Gastia fue cancelada",
        text: `Hola ${firstName}, como no logramos cobrar tu suscripción después de varios intentos, la cancelamos. Tus datos se conservan por un tiempo: puedes volver cuando quieras creando una nueva suscripción en Configuración > Plan y suscripción.`,
        short: "cancelamos tu suscripción tras varios cobros fallidos. Tus datos se conservan; puedes volver creando una nueva suscripción en tu dashboard",
      };
    case "PRECHARGE_ANNUAL":
      return {
        subject: `Tu plan anual de Gastia se cobrará el ${extra?.date ?? "pronto"}`,
        text: `Hola ${firstName}, tu prueba de Gastia termina el ${extra?.date ?? "pronto"}. Ese día cobraremos ${extra?.amount ?? "el monto de tu plan anual"} a tu tarjeta. Recuerda que el plan anual no tiene reembolso después del cobro. Si no quieres continuar, cancela antes desde Configuración > Plan y suscripción y no se te cobrará nada.`,
        short: "tu prueba termina pronto",
      };
    case "RECOVERED":
      return {
        subject: "Recibimos tu pago: tu acceso a Gastia está activo",
        text: `Hola ${firstName}, recibimos tu pago y tu acceso completo a Gastia está activo de nuevo. ¡Gracias!`,
        short: "recibimos tu pago y tu acceso a Gastia está activo de nuevo. ¡Gracias!",
      };
  }
}

function emailHtml(text: string): string {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#101828;">
      <h1 style="color:#164b8a;font-size:22px;margin:0 0 16px;">Gastia</h1>
      <p style="font-size:14px;line-height:1.6;">${safe}</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${env.DASHBOARD_BASE_URL}" style="background:#164b8a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:bold;font-size:14px;display:inline-block;">
          Ir a Gastia
        </a>
      </p>
    </div>`;
}

/** Envía el aviso por los canales que correspondan. Nunca lanza: un fallo de aviso no debe romper el webhook. */
export async function sendBillingNotice(user: NoticeUser, kind: BillingNoticeKind, extra?: NoticeExtra): Promise<void> {
  const firstName = user.name.trim().split(/\s+/)[0] || "Hola";
  const c = copy(kind, firstName, extra);

  try {
    await sendHtmlEmail(user.billingEmail || user.email, c.subject, emailHtml(c.text));
  } catch (err) {
    console.error("No se pudo enviar el correo de cobro:", err);
  }

  if (!WHATSAPP_KINDS.includes(kind) || !user.phoneNumber || !user.whatsappOptIn) return;
  try {
    if (await isWindowOpen(user.phoneNumber)) {
      await sendTextMessage(user.phoneNumber, c.text, { kind: "billing" });
    } else {
      // Plantilla "gastia_cobro_fallido": 2 variables, {{1}} = nombre, {{2}} = mensaje corto (ver docs/plantillas-whatsapp.md).
      await sendTemplateMessage(user.phoneNumber, env.WHATSAPP_TEMPLATE_BILLING, env.WHATSAPP_TEMPLATE_LANG, [firstName, c.short], { kind: "billing" });
    }
  } catch (err) {
    console.error("No se pudo enviar el aviso de cobro por WhatsApp:", err);
  }
}
