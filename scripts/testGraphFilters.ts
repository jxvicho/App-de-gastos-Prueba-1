import { Client } from "@microsoft/microsoft-graph-client";
import { prisma } from "../src/config/prisma";
import { decrypt } from "../src/utils/crypto";
import { getMicrosoftAccessToken } from "../src/services/microsoftOAuth";

async function main() {
  const account = await prisma.emailAccount.findFirst({
    where: { emailAddress: "j4v1ch0@hotmail.com" },
  });

  if (!account) {
    console.error('No se encontró ninguna EmailAccount con emailAddress "j4v1ch0@hotmail.com"');
    return;
  }

  const serializedCache = decrypt(account.refreshToken);
  const { homeAccountId } = JSON.parse(decrypt(account.accessToken)) as { homeAccountId: string };
  const { accessToken } = await getMicrosoftAccessToken(serializedCache, homeAccountId);

  const client = Client.init({ authProvider: (done) => done(null, accessToken) });

  console.log("--- PRUEBA A: solo filtro de remitente ---");
  try {
    const resultA = await client
      .api("/me/messages")
      .header("ConsistencyLevel", "eventual")
      .filter(`from/emailAddress/address eq 'procesos@bbva.com.pe'`)
      .count(true)
      .top(10)
      .select("id,subject,receivedDateTime")
      .get();
    const messagesA = resultA.value ?? [];
    console.log(`PRUEBA A: ${messagesA.length} resultados`);
    if (messagesA.length > 0) {
      console.log("Ejemplo A:", messagesA[0].subject, messagesA[0].receivedDateTime);
    }
  } catch (err) {
    console.error("PRUEBA A falló:", err);
  }

  console.log("--- PRUEBA B: solo filtro de fecha ---");
  try {
    const resultB = await client
      .api("/me/messages")
      .header("ConsistencyLevel", "eventual")
      .filter(`receivedDateTime ge 2026-08-01T00:00:00Z`)
      .count(true)
      .top(10)
      .select("id,subject,receivedDateTime,from")
      .get();
    const messagesB = resultB.value ?? [];
    console.log(`PRUEBA B: ${messagesB.length} resultados`);
    if (messagesB.length > 0) {
      console.log("Ejemplo B:", messagesB[0].subject, messagesB[0].receivedDateTime);
    }
  } catch (err) {
    console.error("PRUEBA B falló:", err);
  }

  console.log("--- PRUEBA C: combinación remitente + fecha ---");
  try {
    const resultC = await client
      .api("/me/messages")
      .header("ConsistencyLevel", "eventual")
      .filter(`from/emailAddress/address eq 'procesos@bbva.com.pe' and receivedDateTime ge 2026-08-01T00:00:00Z`)
      .count(true)
      .top(10)
      .select("id,subject,receivedDateTime")
      .get();
    const messagesC = resultC.value ?? [];
    console.log(`PRUEBA C: ${messagesC.length} resultados`);
    if (messagesC.length > 0) {
      console.log("Ejemplo C:", messagesC[0].subject, messagesC[0].receivedDateTime);
    }
  } catch (err) {
    console.error("PRUEBA C falló:", err);
  }
}

main()
  .catch((err) => {
    console.error("Error ejecutando testGraphFilters:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
