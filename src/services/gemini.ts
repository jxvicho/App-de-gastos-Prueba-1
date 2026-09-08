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
