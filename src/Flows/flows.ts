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

const PHONE_OWNER = process.env.PHONE_OWNER!;

export const flowRouter = addKeyword<Provider, Database>([
  EVENTS.WELCOME,
  EVENTS.VOICE_NOTE,
  EVENTS.TEMPLATE,
  EVENTS.ORDER,
  EVENTS.MEDIA,
  EVENTS.LOCATION,
  EVENTS.DOCUMENT,
  EVENTS.CALL,
]).addAction(async (ctx, { state, gotoFlow, flowDynamic, provider }) => {
  const config = getFunctionConfig("ChatbotIA");
  if (!config.enabled) {
    console.log("⛔️ Flujos apagados desde config.functions.json");
    return;
  }
  const mensajeUsuario = ctx.body || "[contenido no textual]";

  // Guardar mensaje del cliente en base de datos
  await guardarEnBaseDeDatos({
    phone: ctx.from,
    name: ctx.name,
    message: ctx.body,
    source: "CLT",
    messageId: ctx.id,
    timestamp: ctx.timestamp,
  });

  // Verificar si el bot está activo
  const activo = await verificarEstadoBot(ctx.from);
  if (!activo) {
    await mensajeBOT({
      ctx,
      flowDynamic,
      mensaje: "El serivicio no está disponible en este momento.",
    });
    return;
  }
  // 👉 Ejecutar presencia si está activada
  await enviarPresenciaSiActiva(provider, `${ctx.from}@c.us`);
  const bot_id = String(ctx.host ?? PHONE_OWNER);
  const nombre = ctx.name ?? "";
  const numero = ctx.from;

  await guardarContactoEnGoogle(bot_id, nombre, numero);

  // Obtener historial y buscar flujo por IA
  const historial = await obtenerHistorial(ctx.from);
  const resultado = await buscarFlujoDesdeIA(
    `${historial.join("\n")}\nCliente: ${mensajeUsuario}`
  );

  //console.log(`🧠 Mensaje del usuario: ${mensajeUsuario}`);
  //console.log(`🧠 Resultado de IA: ${JSON.stringify(resultado)}`);

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

    //console.log(`🧠 Flujo detectado por IA: ${flujo.nombre}`);

    await state.update({
      flujoNombre: flujo.nombre,
      respuestaIA: flujo.respuesta_default ? undefined : resultado.respuesta,
    });

    return gotoFlow(masterFlow);
  } else if (resultado?.respuesta) {
    // IA no detectó flujo, pero dio una respuesta útil
    await mensajeBOT({
      ctx,
      flowDynamic,
      mensaje: resultado.respuesta,
    });
    return;
  } else {
    // Fallback total
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
