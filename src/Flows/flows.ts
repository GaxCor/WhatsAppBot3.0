import { addKeyword, EVENTS } from "@builderbot/bot";
import {
  buscarFlujoDesdeIA,
  ejecutarFlujo,
  getFlujo,
  getFlujosDisponibles,
  interpretarAccionCalendario,
} from "~/ia";
import type { BaileysProvider as Provider } from "@builderbot/provider-baileys";
import type { MemoryDB as Database } from "@builderbot/bot";
import {
  enviarPresenciaSiActiva,
  guardarEnBaseDeDatos,
  mensajeBOT,
  obtenerHistorial,
  transcribirAudioDesdeMensaje,
  verificarEstadoBot,
} from "~/Utils/functions";
import {
  agendarCitaEnGoogleCalendar,
  eliminarCitaPorEventId,
  guardarContactoEnGoogle,
} from "~/Utils/google";
import { getFunctionConfig } from "~/Utils/configManager";
import { chatFlow } from "~/app";
import { createMessageQueue, QueueConfig } from "~/Utils/fastEntires";
import { formatInTimeZone } from "date-fns-tz";
import { isAfter, isBefore, parse } from "date-fns";

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
  //console.log(ctx);
  if (ctx.key?.fromMe) return;

  enqueueMessage(ctx, async (body) => {
    const { state, gotoFlow, flowDynamic, provider } = tools;

    if (body.toLowerCase().startsWith("/chat")) {
      return gotoFlow(chatFlow);
    }
    if (body.toLowerCase().startsWith("/cita")) {
      return gotoFlow(agendarCita);
    }
    const zona = "America/Monterrey";
    const ahoraStr = formatInTimeZone(new Date(), zona, "HH:mm");
    //console.log(`⏰ Hora actual: ${ahoraStr} `);

    const config = getFunctionConfig("ChatbotIA");
    if (!config.enabled) {
      console.log("⛔️ Flujos apagados desde config.functions.json");
      return;
    }

    // Validar franja horaria si está definida y no vacía
    if (config.hora && config.hora.inicio?.trim() && config.hora.fin?.trim()) {
      const ahora = parse(ahoraStr, "HH:mm", new Date());
      const inicio = parse(config.hora.inicio, "HH:mm", new Date());
      const fin = parse(config.hora.fin, "HH:mm", new Date());

      if (isBefore(ahora, inicio) || isAfter(ahora, fin)) {
        console.log(
          `⛔️ ChatbotIA desactivado por horario: ${config.hora.inicio} a ${config.hora.fin}`
        );
        return;
      }
    }

    let mensajeUsuario = body || "[contenido no textual]";

    // Si es nota de voz, hacer transcripción
    if (mensajeUsuario.includes("_event_voice_note")) {
      const texto = await transcribirAudioDesdeMensaje(ctx, provider);
      //console.log("Transcripción:", texto);
      if (texto) mensajeUsuario = texto;
    }
    console.log("Mensaje del usuario:", mensajeUsuario);

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
      if (resultado.flujo_destino === "agendar_cita") {
        return gotoFlow(agendarCita);
      }

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

export const agendarCita = addKeyword<Provider, Database>(
  EVENTS.ACTION
).addAction(async (ctx, { state, provider, flowDynamic }) => {
  const mensajeUsuario = ctx.body || "";
  const bot_id = String(ctx.host ?? PHONE_OWNER);
  const historial = await obtenerHistorial(ctx.from);
  const resultado = await interpretarAccionCalendario(
    bot_id,
    `${historial.join("\n")}\nCliente: ${mensajeUsuario}`
  );

  if (resultado.funcion === "agregar") {
    await agendarCitaEnGoogleCalendar(
      bot_id,
      resultado.resumen,
      `${resultado.descripcion}\nNúmero: ${ctx.from}`,
      resultado.fechaInicio,
      resultado.fechaFin
    );

    await mensajeBOT({
      ctx,
      flowDynamic,
      mensaje: `✅ Cita agendada para *${
        resultado.resumen
      }* el día *${formatInTimeZone(
        new Date(resultado.fechaInicio),
        "America/Monterrey",
        "dd/MM/yyyy 'a las' HH:mm"
      )}*.`,
    });
    return;
  }

  if (resultado.funcion === "eliminar") {
    const ok = await eliminarCitaPorEventId(bot_id, resultado.eventId);

    await mensajeBOT({
      ctx,
      flowDynamic,
      mensaje: ok
        ? "✅ Tu cita ha sido cancelada exitosamente."
        : "❌ Hubo un problema al eliminar la cita. Asegúrate de que exista.",
    });
    return;
  }

  await mensajeBOT({
    ctx,
    flowDynamic,
    mensaje:
      resultado.mensaje ??
      "❌ No logré entender si deseas agendar o cancelar una cita.",
  });
});
