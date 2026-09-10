import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env";

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export interface ExtractedTransaction {
  isTransaction: boolean;
  type?: "EXPENSE" | "INCOME";
  amount?: number;
  currency?: string;
  merchant?: string;
  description?: string;
  occurredAt?: string;
  suggestedCategory?: string;
}

function buildTransactionSchema(categoryNames: string[]) {
  const properties: Record<string, unknown> = {
    isTransaction: {
      type: "boolean",
      description: "true solo si el correo notifica un cargo, consumo, retiro o depósito real",
    },
    type: { type: "string", enum: ["EXPENSE", "INCOME"] },
    amount: { type: "number" },
    currency: { type: "string", description: "Código de moneda, ej. PEN, USD" },
    merchant: { type: "string", description: "Nombre del comercio o persona involucrada" },
    description: { type: "string", description: "Descripción corta y clara del movimiento" },
    occurredAt: { type: "string", description: "Fecha y hora del movimiento en formato ISO 8601" },
  };

  // Solo pedimos categoría si el usuario tiene al menos una — el enum de
  // Gemini no acepta una lista vacía de opciones.
  if (categoryNames.length > 0) {
    properties.suggestedCategory = {
      type: "string",
      enum: categoryNames,
      description: "La categoría más adecuada para este movimiento, elegida de la lista dada",
    };
  }

  return {
    type: "object",
    properties,
    required: ["isTransaction"],
  } as const;
}

export async function extractTransactionFromEmail(
  emailBodyText: string,
  bankDisplayName: string,
  categoryNames: string[] = []
): Promise<ExtractedTransaction> {
  const categoryInstructions =
    categoryNames.length > 0
      ? `\n\nAdemás, sugiere la categoría más adecuada para este movimiento en "suggestedCategory", eligiendo EXACTAMENTE una de estas opciones (tal como están escritas, sin modificarlas): ${categoryNames.join(", ")}.
Elige la que mejor describa el comercio o la descripción del movimiento. Si ninguna encaja con claridad, usa "Otros comercios" si esa opción está en la lista; si el movimiento no debería contarse como gasto/ingreso real (ej. un pago de tarjeta a uno mismo u otro movimiento interno), usa "No considerar" si está disponible.`
      : "";

  const prompt = `Eres un extractor de datos financieros. Lee el siguiente correo de notificación del banco/billetera "${bankDisplayName}" y extrae los datos de la transacción si el correo efectivamente notifica un movimiento de dinero (cargo, consumo, retiro, transferencia o depósito).

Si el correo NO es una notificación de movimiento real (ej. es publicidad, un estado de cuenta mensual, o un mensaje genérico), responde con isTransaction: false y nada más.${categoryInstructions}

Correo:
"""
${emailBodyText.slice(0, 6000)}
"""`;

  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL_EXTRACTION,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: buildTransactionSchema(categoryNames),
      temperature: 0,
    },
  });

  const text = response.text;
  if (!text) return { isTransaction: false };

  try {
    return JSON.parse(text) as ExtractedTransaction;
  } catch {
    console.error("Gemini devolvió un JSON inválido:", text);
    return { isTransaction: false };
  }
}

export interface ExtractedTransfer {
  isTransferScreenshot: boolean;
  amount?: number;
  currency?: string;
  recipient?: string;
  bankOrWallet?: string;
  fee?: number;
  occurredAt?: string;
  operationNumber?: string;
  suggestedCategory?: string;
}

function buildTransferSchema(categoryNames: string[]) {
  const properties: Record<string, unknown> = {
    isTransferScreenshot: {
      type: "boolean",
      description:
        "true solo si la imagen es una captura de pantalla de una transferencia, Yape, Plin u otra operación bancaria ya realizada",
    },
    amount: { type: "number" },
    currency: { type: "string", description: "Código de moneda, ej. PEN, USD" },
    recipient: { type: "string", description: "Nombre del destinatario o remitente que aparece en la captura" },
    bankOrWallet: { type: "string", description: "Banco o billetera digital de la operación, ej. BCP, Yape, Plin, BBVA" },
    fee: { type: "number", description: "Comisión cobrada, solo si la captura la muestra" },
    occurredAt: { type: "string", description: "Fecha y hora de la operación en formato ISO 8601, si la captura la muestra" },
    operationNumber: { type: "string", description: "Número o código de operación/referencia, si la captura lo muestra" },
  };

  // Igual que en buildTransactionSchema: el enum de Gemini no acepta una
  // lista vacía de opciones.
  if (categoryNames.length > 0) {
    properties.suggestedCategory = {
      type: "string",
      enum: categoryNames,
      description:
        "La categoría más adecuada para este movimiento si resultara ser un gasto, elegida de la lista dada",
    };
  }

  return {
    type: "object",
    properties,
    required: ["isTransferScreenshot"],
  } as const;
}

/**
 * Lee una captura de pantalla de una transferencia/Yape/Plin con Gemini
 * Vision. A diferencia de extractTransactionFromEmail, NO decide si es
 * gasto/traspaso/ingreso — eso se le pregunta siempre al usuario (ver
 * handleIncomingImage en whatsappBot.ts), porque una captura de
 * transferencia es ambigua por naturaleza.
 */
export async function extractTransferFromImage(
  base64: string,
  mimeType: string,
  categoryNames: string[] = []
): Promise<ExtractedTransfer> {
  const categoryInstructions =
    categoryNames.length > 0
      ? `\n\nSi la imagen sí es una transferencia, sugiere también la categoría más adecuada en "suggestedCategory" por si resulta ser un gasto, eligiendo EXACTAMENTE una de estas opciones (tal como están escritas, sin modificarlas): ${categoryNames.join(", ")}.`
      : "";

  const prompt = `Eres un extractor de datos financieros. Mira esta captura de pantalla de una app bancaria o billetera digital (Yape, Plin, BCP, BBVA, Interbank, etc.) y extrae los datos de la operación si efectivamente muestra una transferencia, envío o pago ya realizado.

Si la imagen NO es una captura de una operación bancaria (ej. es una foto de otra cosa), responde con isTransferScreenshot: false y nada más.${categoryInstructions}`;

  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL_EXTRACTION,
    contents: [{ text: prompt }, { inlineData: { data: base64, mimeType } }],
    config: {
      responseMimeType: "application/json",
      responseSchema: buildTransferSchema(categoryNames),
      temperature: 0,
    },
  });

  const text = response.text;
  if (!text) return { isTransferScreenshot: false };

  try {
    return JSON.parse(text) as ExtractedTransfer;
  } catch {
    console.error("Gemini Vision devolvió un JSON inválido:", text);
    return { isTransferScreenshot: false };
  }
}
