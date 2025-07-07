import { getConnection } from "./db/mysql";
import { OpenAI } from "openai";
import type { BaileysProvider } from "@builderbot/provider-baileys";
import { guardarEnBaseDeDatos, mensajeBOT } from "./Utils/functions";
import { formatInTimeZone } from "date-fns-tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { getFunctionConfig } from "./Utils/configManager";
import { obtenerTodasLasFechasDeCitas } from "./Utils/google";

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

export async function interpretarAccionCalendario(
  bot_id: string,
  mensaje: string
): Promise<
  | {
      funcion: "agregar";
      resumen: string;
      descripcion: string;
      fechaInicio: string;
      fechaFin: string;
    }
  | {
      funcion: "eliminar";
      eventId: string;
    }
  | {
      funcion: "ninguna";
      mensaje: string;
    }
> {
  const config = getFunctionConfig("CalendarioGoogle");
  if (!config?.cantidad) {
    return {
      funcion: "ninguna",
      mensaje: "No está configurada la función CalendarioGoogle.",
    };
  }

  const zona = "America/Monterrey";
  const ahora = new Date();
  const fechaHoraBonita = formatInTimeZone(
    ahora,
    zona,
    "EEEE d 'de' MMMM 'de' yyyy 'a las' HH:mm:ss",
    { locale: es }
  );

  const eventos = await obtenerTodasLasFechasDeCitas(bot_id);
  const eventosTexto = eventos
    .map(
      (ev) =>
        `- ID: ${ev.eventId}, Resumen: ${ev.resumen}, Fecha: ${formatInTimeZone(
          new Date(ev.fechaInicio),
          zona,
          "EEEE d 'de' MMMM yyyy, HH:mm",
          { locale: es }
        )}`
    )
    .join("\n");

  const prompt = `
Eres un asistente para gestionar citas. Tu tarea es interpretar si el usuario quiere AGENDAR o CANCELAR una cita.

Hora actual: ${fechaHoraBonita}
Horario del negocio: ${config.horario}

Si el usuario quiere agendar una cita (sinónimos: agendar, registrar, programar, hacer), responde así:
{
  "funcion": "agregar",
  "resumen": "...",
  "descripcion": "...",
  "fechaInicio": "YYYY-MM-DDTHH:mm:ss-06:00",
  "fechaFin": "YYYY-MM-DDTHH:mm:ss-06:00"
}

- Si el mensaje es para CANCELAR una cita y contiene la información mínima (fecha y descripción), responde así:
{
  "funcion": "eliminar",
  "eventId": "abc123"
}


Si no hay coincidencia clara, responde con:
{
  "funcion": "ninguna",
  "mensaje": "No se encontró la cita que deseas cancelar."
}

Eventos disponibles:
${eventosTexto}

Texto del usuario:
"""${mensaje}"""
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  let respuestaIA: any = {};
  try {
    respuestaIA = JSON.parse(completion.choices[0].message.content ?? "{}");
  } catch (e) {
    return {
      funcion: "ninguna",
      mensaje: "No se pudo interpretar el mensaje.",
    };
  }

  // Paso 2: Procesar resultado
  if (respuestaIA.funcion === "eliminar") {
    const evento = eventos.find((ev) => ev.eventId === respuestaIA.eventId);
    if (!evento) {
      return {
        funcion: "ninguna",
        mensaje: "No se encontró la cita que deseas cancelar.",
      };
    }

    return {
      funcion: "eliminar",
      eventId: evento.eventId,
    };
  }

  if (respuestaIA.funcion === "agregar") {
    const inicioNueva = new Date(respuestaIA.fechaInicio);
    const finNueva = new Date(respuestaIA.fechaFin);
    const empalmes = eventos.filter((ev) => {
      const inicioEv = new Date(ev.fechaInicio);
      const finEv = new Date(ev.fechaFin);
      return inicioNueva < finEv && finNueva > inicioEv;
    });

    if (empalmes.length >= config.cantidad) {
      return {
        funcion: "ninguna",
        mensaje: `⚠️ Ya hay ${empalmes.length} citas en ese horario. El máximo permitido es ${config.cantidad}.`,
      };
    }

    return {
      funcion: "agregar",
      resumen: respuestaIA.resumen,
      descripcion: respuestaIA.descripcion,
      fechaInicio: respuestaIA.fechaInicio,
      fechaFin: respuestaIA.fechaFin,
    };
  }

  return {
    funcion: "ninguna",
    mensaje: respuestaIA.mensaje || "No se pudo determinar la intención.",
  };
}
