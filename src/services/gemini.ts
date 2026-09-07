import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env";

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const TRANSACTION_SCHEMA = {
  type: "object",
  properties: {
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
  },
  required: ["isTransaction"],
} as const;

export interface ExtractedTransaction {
  isTransaction: boolean;
  type?: "EXPENSE" | "INCOME";
  amount?: number;
  currency?: string;
  merchant?: string;
  description?: string;
  occurredAt?: string;
}

export async function extractTransactionFromEmail(
  emailBodyText: string,
  bankDisplayName: string
): Promise<ExtractedTransaction> {
  const prompt = `Eres un extractor de datos financieros. Lee el siguiente correo de notificación del banco/billetera "${bankDisplayName}" y extrae los datos de la transacción si el correo efectivamente notifica un movimiento de dinero (cargo, consumo, retiro, transferencia o depósito).

Si el correo NO es una notificación de movimiento real (ej. es publicidad, un estado de cuenta mensual, o un mensaje genérico), responde con isTransaction: false y nada más.

Correo:
"""
${emailBodyText.slice(0, 6000)}
"""`;

  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL_EXTRACTION,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: TRANSACTION_SCHEMA,
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
