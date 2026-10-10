import { google } from "googleapis";
import { env } from "../config/env";

// gmail.readonly basta para leer los correos del banco y para pedir el
// perfil (users.getProfile) con el que sabemos qué dirección se conectó.
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function isGoogleConfigured(): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

export function createGoogleClient() {
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
}

export function getGoogleAuthUrl(state: string): string {
  return createGoogleClient().generateAuthUrl({
    access_type: "offline", // necesario para recibir refresh_token
    prompt: "consent", // fuerza refresh_token aunque ya haya autorizado antes
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export interface GoogleTokenResult {
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokenResult> {
  const client = createGoogleClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error("Google no devolvió un access token");
  if (!tokens.refresh_token) {
    throw new Error(
      "Google no devolvió refresh token. Revoca el acceso de Gastia en myaccount.google.com/permissions y vuelve a conectar."
    );
  }
  client.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress;
  if (!email) throw new Error("No se pudo obtener la dirección de Gmail conectada");

  return {
    email: email.toLowerCase(),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000),
  };
}

/** Devuelve un cliente de Gmail autenticado; googleapis renueva el access token solo con el refresh token. */
export function getGmailClient(refreshToken: string) {
  const client = createGoogleClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: client });
}
