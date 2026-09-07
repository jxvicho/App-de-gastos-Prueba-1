import {
  ConfidentialClientApplication,
  Configuration,
  AuthorizationUrlRequest,
  AuthorizationCodeRequest,
} from "@azure/msal-node";
import { env } from "../config/env";

const GRAPH_SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
];

function buildMsalConfig(): Configuration {
  return {
    auth: {
      clientId: env.MS_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${env.MS_TENANT_ID || "common"}`,
      clientSecret: env.MS_CLIENT_SECRET,
    },
  };
}

export function createMsalClient(serializedCache?: string) {
  const cca = new ConfidentialClientApplication(buildMsalConfig());
  if (serializedCache) {
    cca.getTokenCache().deserialize(serializedCache);
  }
  return cca;
}

export async function getMicrosoftAuthUrl(state: string): Promise<string> {
  const cca = createMsalClient();
  const request: AuthorizationUrlRequest = {
    scopes: GRAPH_SCOPES,
    redirectUri: env.MS_REDIRECT_URI,
    state,
    prompt: "consent",
  };
  return cca.getAuthCodeUrl(request);
}

export interface MicrosoftTokenResult {
  accessToken: string;
  email: string;
  homeAccountId: string;
  serializedCache: string;
  expiresOn: Date;
}

export async function exchangeMicrosoftCode(code: string): Promise<MicrosoftTokenResult> {
  const cca = createMsalClient();
  const request: AuthorizationCodeRequest = {
    code,
    scopes: GRAPH_SCOPES,
    redirectUri: env.MS_REDIRECT_URI,
  };

  const response = await cca.acquireTokenByCode(request);
  if (!response?.account) {
    throw new Error("Microsoft no devolvió una cuenta válida en el intercambio de código");
  }

  return {
    accessToken: response.accessToken,
    email: response.account.username,
    homeAccountId: response.account.homeAccountId,
    serializedCache: cca.getTokenCache().serialize(),
    expiresOn: response.expiresOn ?? new Date(Date.now() + 3600_000),
  };
}

export async function getMicrosoftAccessToken(
  serializedCache: string,
  homeAccountId: string
): Promise<{ accessToken: string; updatedCache: string }> {
  const cca = createMsalClient(serializedCache);
  const account = await cca.getTokenCache().getAccountByHomeId(homeAccountId);
  if (!account) throw new Error("No se encontró la cuenta de Microsoft en el cache guardado");

  const response = await cca.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
  if (!response) throw new Error("No se pudo renovar el token de Microsoft");

  return { accessToken: response.accessToken, updatedCache: cca.getTokenCache().serialize() };
}
