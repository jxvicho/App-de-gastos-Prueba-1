import { Resend } from "resend";
import { env } from "../config/env";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/**
 * Manda el correo de "recuperar contraseña" con el link de un solo uso.
 *
 * Si no hay RESEND_API_KEY configurada (ej. en un entorno de desarrollo que
 * todavía no tiene la cuenta de Resend lista), no revienta el flujo: solo
 * deja el link en la consola del backend para poder seguir probando.
 */
export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
  if (!resend) {
    console.log(`✉️  [dev] Sin RESEND_API_KEY configurada. Link de recuperación para ${to}:\n${resetUrl}`);
    return;
  }

  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to,
    subject: "Recupera tu contraseña de Gastia",
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#101828;">
        <h1 style="color:#164b8a;font-size:22px;margin:0 0 16px;">Gastia</h1>
        <p style="font-size:14px;line-height:1.6;">Hola ${name},</p>
        <p style="font-size:14px;line-height:1.6;">
          Recibimos una solicitud para restablecer la contraseña de tu cuenta.
          Si fuiste tú, haz clic en el siguiente botón (válido por 1 hora):
        </p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${resetUrl}" style="background:#164b8a;color:#fff;text-decoration:none;
             padding:12px 24px;border-radius:10px;font-weight:bold;font-size:14px;display:inline-block;">
            Restablecer contraseña
          </a>
        </p>
        <p style="font-size:12.5px;line-height:1.6;color:#5b6675;">
          Si tú no pediste esto, puedes ignorar este correo — tu contraseña actual sigue funcionando sin cambios.
        </p>
        <p style="font-size:12px;color:#8b96a5;margin-top:24px;">
          Si el botón no funciona, copia y pega este enlace en tu navegador:<br>
          <span style="word-break:break-all;">${resetUrl}</span>
        </p>
      </div>
    `,
  });

  if (error) {
    console.error("❌ Error enviando correo de recuperación (Resend):", error);
    throw new Error("No se pudo enviar el correo de recuperación");
  }
}

/** Correo transaccional genérico (avisos de cobro). Sin RESEND_API_KEY solo lo deja en el log. Nunca lanza. */
export async function sendHtmlEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!resend) {
    console.log(`✉️  [dev] Sin RESEND_API_KEY. Correo para ${to}: ${subject}`);
    return false;
  }
  try {
    const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html });
    if (error) {
      console.error("❌ Error enviando correo (Resend):", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("❌ Error enviando correo (Resend):", err);
    return false;
  }
}


/** Código de 6 dígitos para verificar el correo al crear la cuenta. Sin RESEND_API_KEY solo lo deja en el log. */
export async function sendVerificationCodeEmail(to: string, name: string, code: string): Promise<boolean> {
  if (!resend) {
    console.log(`✉️  [dev] Sin RESEND_API_KEY. Código de verificación para ${to}: ${code}`);
    return true;
  }
  const safeName = name.replace(/[<>&"]/g, "");
  return sendHtmlEmail(
    to,
    `${code} es tu código de Gastia`,
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#101828;">
      <h1 style="color:#164b8a;font-size:22px;margin:0 0 16px;">Gastia</h1>
      <p style="font-size:14px;line-height:1.6;">Hola ${safeName},</p>
      <p style="font-size:14px;line-height:1.6;">Usa este código para verificar tu correo y activar tu cuenta (vence en 15 minutos):</p>
      <p style="text-align:center;margin:26px 0;"><span style="display:inline-block;background:#eaf2fb;color:#0b2545;font-size:32px;font-weight:bold;letter-spacing:8px;padding:14px 22px;border-radius:12px;">${code}</span></p>
      <p style="font-size:12.5px;line-height:1.6;color:#5b6675;">Si tú no creaste una cuenta en Gastia, ignora este correo: nadie podrá usar tu dirección sin este código.</p>
    </div>`
  );
}
