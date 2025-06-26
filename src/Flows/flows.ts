import { addKeyword, EVENTS } from "@builderbot/bot";
import {
  buscarFlujoDesdeIA,
  ejecutarFlujo,
  getFlujo,
  getFlujosDisponibles,
} from "~/ia";
import type { BaileysProvider as Provider } from "@builderbot/provider-baileys";
import type { MemoryDB as Database } from "@builderbot/bot";
import {
  enviarPresenciaSiActiva,
  guardarEnBaseDeDatos,
  mensajeBOT,
  obtenerHistorial,
  verificarEstadoBot,
} from "~/Utils/functions";
import {
  existeNumeroEnContactos,
  guardarContactoEnGoogle,
} from "~/Utils/google";
import { getFunctionConfig } from "~/Utils/configManager";
import { chatFlow } from "~/app";
import { createMessageQueue, QueueConfig } from "~/Utils/fastEntires";

const PHONE_OWNER = process.env.PHONE_OWNER!;
const SECONDS_TO_WAIT = Number(process.env.SECONDSTOWAIT) * 1000;
const queueConfig: QueueConfig = { gapMilliseconds: SECONDS_TO_WAIT ?? 6000 };
const enqueueMessage = createMessageQueue(queueConfig);

export const flowRouter = addKeyword<Provider, Database>([
  EVENTS.WELCOME,
  EVENTS.VOICE_NOTE,
  EVENTS.TEMPLATE,
  EVENTS.ORDER,
  EVENTS.MEDIA,
  EVENTS.LOCATION,
  EVENTS.DOCUMENT,
  EVENTS.CALL,
]).addAction(async (ctx, tools) => {
  await guardarEnBaseDeDatos({
    phone: ctx.from,
    name: ctx.name,
    message: ctx.body,
    source: ctx.key?.fromMe ? "WHA" : "CLT",
    messageId: ctx.id,
    timestamp: ctx.timestamp,
  });

  if (ctx.key?.fromMe) return;
  enqueueMessage(ctx, async (body) => {
    const { state, gotoFlow, flowDynamic, provider } = tools;

    if (body.toLowerCase().startsWith("/chat")) {
      return gotoFlow(chatFlow);
    }

    const config = getFunctionConfig("ChatbotIA");
    if (!config.enabled) {
      console.log("⛔️ Flujos apagados desde config.functions.json");
      await mensajeBOT({
        ctx,
        flowDynamic,
        mensaje: "El servicio no está disponible en este momento.",
      });
      return;
    }

    const mensajeUsuario = body || "[contenido no textual]";

    const activo = await verificarEstadoBot(ctx.from);
    if (!activo) {
      return;
    }

    await enviarPresenciaSiActiva(provider, `${ctx.from}@c.us`);
    const bot_id = String(ctx.host ?? PHONE_OWNER);
    const nombre = ctx.name ?? "";
    const numero = ctx.from;

    await guardarContactoEnGoogle(bot_id, nombre, numero);

    const historial = await obtenerHistorial(ctx.from);
    const resultado = await buscarFlujoDesdeIA(
      `${historial.join("\n")}\nCliente: ${mensajeUsuario}`
    );

    if (resultado?.flujo_destino) {
      const flujo = await getFlujo(resultado.flujo_destino);
      if (!flujo) {
        const flujos = await getFlujosDisponibles();
        const lista = flujos.map((f) => f.nombre).join(" y ");
        await mensajeBOT({
          ctx,
          flowDynamic,
          mensaje: `Ese tema aún no está disponible. Por ahora puedo ayudarte con ${lista}.`,
        });
        return;
      }

      await state.update({
        flujoNombre: flujo.nombre,
        respuestaIA: flujo.respuesta_default ? undefined : resultado.respuesta,
      });

      return gotoFlow(masterFlow);
    } else if (resultado?.respuesta) {
      await mensajeBOT({
        ctx,
        flowDynamic,
        mensaje: resultado.respuesta,
      });
      return;
    } else {
      const flujos = await getFlujosDisponibles();
      const lista = flujos.map((f) => f.nombre).join(" y ");
      await mensajeBOT({
        ctx,
        flowDynamic,
        mensaje: `No logré entender el mensaje. Por ahora solo puedo ayudarte con ${lista}.`,
      });
      return;
    }
  });
});

export const masterFlow = addKeyword<Provider, Database>(
  EVENTS.ACTION
).addAction(async (ctx, { state, provider, flowDynamic }) => {
  const { flujoNombre, respuestaIA } = state.getMyState();
  const flujo = await getFlujo(flujoNombre);

  if (!flujo) {
    await mensajeBOT({
      ctx,
      flowDynamic,
      mensaje: "No pude cargar el contenido.",
    });
    return;
  }

  await ejecutarFlujo(ctx, flujo, {
    respuestaIA,
    provider,
    flowDynamic,
  });
});
