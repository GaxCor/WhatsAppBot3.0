import { addKeyword, EVENTS } from "@builderbot/bot";
import { buscarFlujoDesdeIA, ejecutarFlujo, getFlujo, getFlujosDisponibles, interpretarAccionCalendario, } from "../ia.js";
import { enviarPresenciaSiActiva, guardarEnBaseDeDatos, mensajeBOT, obtenerHistorial, transcribirAudioDesdeMensaje, verificarEstadoBot, } from "../Utils/functions.js";
import { agendarCitaEnGoogleCalendar, eliminarCitaPorEventId, guardarContactoEnGoogle, } from "../Utils/google.js";
import { getFunctionConfig } from "../Utils/configManager.js";
import { chatFlow } from "../app.js";
import { createMessageQueue } from "../Utils/fastEntires.js";
import { formatInTimeZone } from "date-fns-tz";
import { isAfter, isBefore, parse } from "date-fns";
const PHONE_OWNER = process.env.PHONE_OWNER;
const SECONDS_TO_WAIT = Number(process.env.SECONDSTOWAIT) * 1000;
const queueConfig = { gapMilliseconds: SECONDS_TO_WAIT ?? 6000 };
const enqueueMessage = createMessageQueue(queueConfig);
export const flowRouter = addKeyword([
    EVENTS.WELCOME,
    EVENTS.VOICE_NOTE,
    EVENTS.TEMPLATE,
    EVENTS.ORDER,
    EVENTS.MEDIA,
    EVENTS.LOCATION,
    EVENTS.DOCUMENT,
    EVENTS.CALL,
]).addAction(async (ctx, tools) => {
    if (ctx.key?.fromMe) {
        await guardarEnBaseDeDatos({
            phone: ctx.from,
            name: ctx.name,
            message: ctx.body,
            source: "WHA",
            messageId: ctx.id,
            timestamp: ctx.timestamp,
        });
    }
    else {
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
            const config = getFunctionConfig("ChatbotIA");
            if (!config.enabled) {
                console.log("⛔️ Flujos apagados desde config.functions.json");
                return;
            }
            if (config.hora &&
                config.hora.inicio?.trim() &&
                config.hora.fin?.trim()) {
                const ahora = parse(ahoraStr, "HH:mm", new Date());
                const inicio = parse(config.hora.inicio, "HH:mm", new Date());
                const fin = parse(config.hora.fin, "HH:mm", new Date());
                if (isBefore(ahora, inicio) || isAfter(ahora, fin)) {
                    console.log(`⛔️ ChatbotIA desactivado por horario: ${config.hora.inicio} a ${config.hora.fin}`);
                    return;
                }
            }
            let mensajeUsuario = body || "[contenido no textual]";
            if (mensajeUsuario.includes("_event_voice_note")) {
                const texto = await transcribirAudioDesdeMensaje(ctx, provider);
                if (texto)
                    mensajeUsuario = texto;
            }
            console.log("Mensaje del usuario:", mensajeUsuario);
            await guardarEnBaseDeDatos({
                phone: ctx.from,
                name: ctx.name,
                message: mensajeUsuario,
                source: "CLT",
                messageId: ctx.id,
                timestamp: ctx.timestamp,
            });
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
            const resultado = await buscarFlujoDesdeIA(`${historial.join("\n")}\nCliente: ${mensajeUsuario}`);
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
                    respuestaIA: flujo.respuesta_default
                        ? undefined
                        : resultado.respuesta,
                });
                return gotoFlow(masterFlow);
            }
            else if (resultado?.respuesta) {
                await mensajeBOT({
                    ctx,
                    flowDynamic,
                    mensaje: resultado.respuesta,
                });
                return;
            }
            else {
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
    }
});
export const masterFlow = addKeyword(EVENTS.ACTION).addAction(async (ctx, { state, provider, flowDynamic }) => {
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
export const agendarCita = addKeyword(EVENTS.ACTION).addAction(async (ctx, { state, provider, flowDynamic }) => {
    const mensajeUsuario = ctx.body || "";
    const bot_id = String(ctx.host ?? PHONE_OWNER);
    const historial = await obtenerHistorial(ctx.from);
    const resultado = await interpretarAccionCalendario(bot_id, `${historial.join("\n")}\nCliente: ${mensajeUsuario}`);
    if (resultado.funcion === "agregar") {
        await agendarCitaEnGoogleCalendar(bot_id, resultado.resumen, `${resultado.descripcion}\nNúmero: ${ctx.from}`, resultado.fechaInicio, resultado.fechaFin);
        await mensajeBOT({
            ctx,
            flowDynamic,
            mensaje: `✅ Cita agendada para *${resultado.resumen}* el día *${formatInTimeZone(new Date(resultado.fechaInicio), "America/Monterrey", "dd/MM/yyyy 'a las' HH:mm")}*.`,
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
        mensaje: resultado.mensaje ??
            "❌ No logré entender si deseas agendar o cancelar una cita.",
    });
});
