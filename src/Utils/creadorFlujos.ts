import { OpenAI } from "openai";
import { globalState } from "./globalStateFlujos";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4.1";
const MAX_HISTORIAL = 20;

/* Tipos */
type FuncionCRUD =
  | "crear"
  | "editar"
  | "eliminar"
  | "ver"
  | "finalizar"
  | "desconocida";
interface IntencionDetectada {
  funcion: FuncionCRUD;
  respuesta: string;
  args?: any;
}
interface RespuestaFinal {
  respuesta: string;
  flujos: Record<string, any>;
  finalizado?: boolean;
}

const CAMPOS_FIJO = [
  "nombre",
  "activado",
  "imagen_url",
  "video_url",
  "sticker_url",
  "audio_url",
  "documento_url",
  "lat",
  "lng",
  "prompt",
] as const;
type CampoFlujo = (typeof CAMPOS_FIJO)[number];

/* Utils */
const normalizarNombre = (s = "") =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const limpiar = (raw: any) => {
  if (!raw?.nombre) return null;
  const f: Record<CampoFlujo, any> = {} as any;

  f.nombre = normalizarNombre(raw.nombre);
  f.activado = typeof raw.activado === "boolean" ? raw.activado : true;
  for (const k of [
    "imagen_url",
    "video_url",
    "sticker_url",
    "audio_url",
    "documento_url",
  ] as CampoFlujo[]) {
    f[k] = typeof raw[k] === "string" ? raw[k] : "";
  }
  f.lat = typeof raw.lat === "number" ? raw.lat : null;
  f.lng = typeof raw.lng === "number" ? raw.lng : null;
  f.prompt = typeof raw.prompt === "string" ? raw.prompt : "";

  return f;
};

const asObj = (arr: any[]) => Object.fromEntries(arr.map((f) => [f.nombre, f]));

const ficha = (f: any) => {
  const extras =
    [
      f.imagen_url && "imagen",
      f.video_url && "video",
      f.sticker_url && "sticker",
      f.audio_url && "audio",
      f.documento_url && "documento",
      f.lat && f.lng && "ubicación",
    ]
      .filter(Boolean)
      .join(", ") || "ninguno";

  return `🧩 ${f.nombre}\n📝 ${
    f.prompt?.slice(0, 60) || "(sin prompt)"
  }\n📷 ${extras}`;
};

/* ───── INTENCIÓN ───── */
async function detectarIntencionConIA(
  mensaje: string,
  historial: any[]
): Promise<IntencionDetectada> {
  const historiaTexto = historial
    .map((h) => `🧑 ${h.user}\n🤖 ${h.bot}`)
    .join("\n\n");

  const flujos = globalState.get("flujosTemporales") || [];
  const flujosTexto = flujos.length
    ? flujos.map(ficha).join("\n\n")
    : "— No hay flujos guardados —";

  const prompt = `
Eres un asistente experto en construir flujos conversacionales para bots de WhatsApp.

Tu tarea es interpretar el mensaje del usuario (y su historial reciente) y determinar si desea:
- crear un nuevo flujo
- editar uno existente
- eliminar un flujo
- ver los flujos guardados
- finalizar el diseño (si el usuario dice que ya terminó)

Debes deducir:
- La intención: "crear", "editar", "eliminar", "ver", "finalizar"
- Una respuesta amable para mostrarle al usuario
- En caso de "crear" o "editar", los campos deducidos: al menos "nombre" y "prompt"
- En caso de "eliminar", deduce el nombre más probable incluso si no se menciona literalmente

Responde SIEMPRE SOLO con un JSON con esta estructura:
{
  "funcion": "crear" | "editar" | "eliminar" | "ver" | "finalizar" | "desconocida",
  "respuesta": "texto para el usuario",
  "args": { ...opcional... }
}

Flujos existentes:
${flujosTexto}

Historial de conversación:
${historiaTexto}

Nuevo mensaje del usuario:
🧑 ${mensaje}
`;

  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: "Responde solo con JSON válido. No des contexto adicional.",
      },
      { role: "user", content: prompt },
    ],
  });

  const raw = resp.choices[0].message.content?.trim() || "";
  console.log("🔍 INTENCIÓN IA:", raw);

  try {
    const json = raw.match(/```json\s*([\s\S]*?)```/)?.[1] ?? raw;
    return JSON.parse(json);
  } catch (e) {
    console.error("❌ Error al interpretar intención:", e);
    return { funcion: "desconocida", respuesta: "❌ No entendí tu intención." };
  }
}

/* ───── CRUD ───── */
function crearFlujos(args: any, arr: any[]): RespuestaFinal {
  const nuevos = Array.isArray(args) ? args : [args];
  const creados: string[] = [];

  for (const a of nuevos) {
    if (!a?.nombre || !a?.prompt) continue;
    const flujo = limpiar(a);
    if (!flujo) continue;

    const idx = arr.findIndex((f) => f.nombre === flujo.nombre);
    idx >= 0 ? (arr[idx] = flujo) : arr.push(flujo);
    creados.push(flujo.nombre);
  }

  if (creados.length) {
    console.log("🆕 Flujos guardados:", creados.join(", "));
  }
  return {
    respuesta: "", // Se sobrescribirá después
    flujos: asObj(arr),
  };
}

function editarFlujos(args: any, arr: any[]): RespuestaFinal {
  const ediciones = Array.isArray(args) ? args : [args];
  const actualizados: string[] = [];

  for (const a of ediciones) {
    if (!a?.nombre) continue;
    const nom = normalizarNombre(a.nombre);
    const idx = arr.findIndex((f) => f.nombre === nom);
    if (idx === -1) continue;

    arr[idx] = limpiar({ ...arr[idx], ...a });
    actualizados.push(nom);
  }

  if (actualizados.length) {
    console.log("✏️ Flujos actualizados:", actualizados.join(", "));
  }

  return {
    respuesta: "", // Será reemplazada luego por intencion.respuesta
    flujos: asObj(arr),
  };
}

function eliminarFlujos(args: any, arr: any[]): RespuestaFinal {
  const nombres = Array.isArray(args?.nombre) ? args.nombre : [args?.nombre];
  const eliminados: string[] = [];
  const normalizados = nombres
    .filter(Boolean)
    .map((s: string) => normalizarNombre(s));

  const nuevos = arr.filter((f) => {
    const eliminar = normalizados.includes(f.nombre);
    if (eliminar) eliminados.push(f.nombre);
    return !eliminar;
  });

  if (eliminados.length) {
    console.log("🗑 Flujos eliminados:", eliminados.join(", "));
  }
  return {
    respuesta: "", // Se sobrescribirá después
    flujos: asObj(nuevos),
  };
}

function verFlujos(_: any, arr: any[]): RespuestaFinal {
  return {
    respuesta: arr.length ? arr.map(ficha).join("\n\n") : "— Sin flujos —",
    flujos: asObj(arr),
  };
}

function finalizarFlujos(_: any, arr: any[]): RespuestaFinal {
  return {
    respuesta: "✅ Flujos finalizados. Puedes copiarlos o guardarlos.",
    flujos: asObj(arr),
    finalizado: true,
  };
}

/* ───── FUNCIÓN PRINCIPAL ───── */
export async function interpretarMensajeParaFlujo(
  mensaje: string
): Promise<RespuestaFinal> {
  const flujos = globalState.get("flujosTemporales") || [];
  const hist = globalState.get("histFlujos") || [];

  const intencion = await detectarIntencionConIA(
    mensaje,
    hist.slice(-MAX_HISTORIAL)
  );

  let resultado: RespuestaFinal = {
    respuesta: intencion.respuesta,
    flujos: asObj(flujos),
  };

  switch (intencion.funcion) {
    case "crear":
      resultado = crearFlujos(intencion.args?.flujos ?? intencion.args, flujos);
      break;
    case "editar":
      resultado = editarFlujos(
        intencion.args?.flujos ?? intencion.args,
        flujos
      );
      break;
    case "eliminar":
      resultado = eliminarFlujos(intencion.args, flujos);
      break;
    case "ver":
      resultado = verFlujos(intencion.args, flujos);
      break;
    case "finalizar":
      resultado = finalizarFlujos(intencion.args, flujos);
      break;
  }
  resultado.respuesta = intencion.respuesta;
  await globalState.update({
    flujosTemporales: Object.values(resultado.flujos),
    histFlujos: [...hist, { user: mensaje, bot: resultado.respuesta }].slice(
      -MAX_HISTORIAL
    ),
  });

  console.log("➡ RESPUESTA FINAL:", resultado.respuesta);
  return resultado;
}
