import { getConnection } from "./db/mysql";
import { OpenAI } from "openai";
import type { BaileysProvider } from "@builderbot/provider-baileys";
import { guardarEnBaseDeDatos, mensajeBOT } from "./Utils/functions";
import { formatInTimeZone } from "date-fns-tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";

const toJid = (num: string) => (num.includes("@") ? num : `${num}@c.us`);

export async function getFlujosDisponibles() {
  const conn = await getConnection();
  const [rows] = await conn.execute(
    "SELECT nombre FROM flujos WHERE activado = 1"
  );
  return rows as { nombre: string }[];
}

export async function getFlujo(nombre: string) {
  const conn = await getConnection();
  const [rows] = await conn.execute(
    "SELECT * FROM flujos WHERE nombre = ? AND activado = 1 LIMIT 1",
    [nombre]
  );
  return rows[0] || null;
}

export async function ejecutarFlujo(
  ctx: any,
  flujo: any,
  opciones: {
    respuestaIA?: string;
    provider: BaileysProvider;
    flowDynamic: (mensaje: string | string[]) => Promise<void>;
  }
) {
  const { respuestaIA, provider, flowDynamic } = opciones;
  const number = ctx.from;
  if (!number) return console.warn("⚠️ Número no definido en ctx.from");
  const jid = toJid(number);
  try {
    if (respuestaIA?.trim()) {
      await mensajeBOT({ ctx, flowDynamic, mensaje: respuestaIA.trim() });
    }

    if (flujo.imagen_url?.startsWith("http")) {
      await provider.sendImage(jid, flujo.imagen_url, "");
      await guardarEnBaseDeDatos({
        phone: number,
        message: "[Imagen enviada]",
        source: "BOT",
      });
    }

    if (flujo.video_url?.startsWith("http")) {
      await provider.sendVideo(jid, flujo.video_url, "");
      await guardarEnBaseDeDatos({
        phone: number,
        message: "[Video enviado]",
        source: "BOT",
      });
    }

    if (flujo.sticker_url?.startsWith("http")) {
      await provider.sendSticker(jid, flujo.sticker_url, {
        pack: "Bot",
        author: "AI",
      });
      await guardarEnBaseDeDatos({
        phone: number,
        message: "[Sticker enviado]",
        source: "BOT",
      });
    }

    if (flujo.audio_url?.startsWith("http")) {
      await provider.sendAudio(jid, flujo.audio_url);
      await guardarEnBaseDeDatos({
        phone: number,
        message: "[Audio enviado]",
        source: "BOT",
      });
    }

    if (flujo.documento_url?.startsWith("http")) {
      await provider.sendFile(
        jid,
        flujo.documento_url,
        "Aquí tienes el archivo."
      );
      await guardarEnBaseDeDatos({
        phone: number,
        message: "[Documento enviado]",
        source: "BOT",
      });
    }

    if (flujo.lat != null && flujo.lng != null) {
      await provider.sendLocation(jid, flujo.lat, flujo.lng);
      await guardarEnBaseDeDatos({
        phone: number,
        message: "[Ubicación enviada]",
        source: "BOT",
      });
    }
  } catch (error) {
    console.error("❌ Error al ejecutar flujo:", error);
  }
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function buscarFlujoDesdeIA(
  mensaje: string
): Promise<{ flujo_destino: string; respuesta: string }> {
  const conn = await getConnection();
  const [flujos] = await conn.query(
    "SELECT nombre, prompt FROM flujos WHERE activado = 1"
  );
  const zona = "America/Monterrey";
  const ahora = new Date();

  const fechaHoraBonita = formatInTimeZone(
    ahora,
    zona,
    "EEEE d 'de' MMMM 'de' yyyy 'a las' HH:mm:ss",
    { locale: es }
  );
  //console.log(`🕒 Hora actual: ${fechaHoraBonita}`);
  const systemPrompt = `
Eres un asistente para WhatsApp.

Tu tarea es:
1. Analizar el mensaje del cliente.
2. Elegir cuál de los siguientes flujos es más adecuado con base en el contexto y la descripción del flujo.
3. Generar una respuesta breve, clara y útil.

Instrucciones clave:
- Solo responde lo necesario. No incluyas saludos, despedidas ni frases como "Estoy aquí para ayudarte", "No dudes en preguntar", etc.
- La respuesta debe tener máximo 2 oraciones o 250 caracteres.
- Si incluyes horarios, escríbelos en un solo bloque claro (ej: "Lunes a viernes de 8:30 a 18:30 h, sábados de 9:00 a 14:00 h").
- No uses listas, saltos de línea ni viñetas. El mensaje debe ser una sola unidad continua de texto.
- Recuerda que el mensaje se formatea antes de enviarse, así que evita frases largas o compuestas que puedan romperse mal.

Devuelve un JSON con este formato:
{
  "flujo_destino": "nombre_del_flujo" o vacío "",
  "respuesta": "respuesta breve y útil para el cliente"
}

Hora actual: ${fechaHoraBonita}

Flujos disponibles:
${(flujos as any[]).map((f) => `- ${f.nombre}: ${f.prompt}`).join("\n")}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Mensaje del cliente: ${mensaje}` },
    ],
  });

  let content = completion.choices[0].message?.content?.trim() || "{}";

  if (content.startsWith("```json")) {
    content = content
      .replace(/^```json/, "")
      .replace(/```$/, "")
      .trim();
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    console.error("❌ JSON inválido desde OpenAI:", content);
    return {
      flujo_destino: "",
      respuesta: "Lo siento, no entendí tu mensaje. ¿Podrías reformularlo?",
    };
  }
}
