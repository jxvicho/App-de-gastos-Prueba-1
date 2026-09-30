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
