import path from "path";
import { createBot, createProvider, createFlow, addKeyword, EVENTS, } from "@builderbot/bot";
import { MemoryDB as Database } from "@builderbot/bot";
import { BaileysProvider as Provider } from "@builderbot/provider-baileys";
import { actualizarEstadoBot, exportarChatCSV, exportarTablasExcel, obtenerEstadoGlobalBot, } from "./Utils/functions.js";
import { guardarTokenEnDB, handleAuthGoogle, } from "./Utils/google.js";
import dotenv from "dotenv";
import { agendarCita, flowRouter, masterFlow } from "./Flows/flows.js";
import { mostrarEstadoBot } from "./Utils/mostrarEstadoConfig.js";
import { buscarFlujoDesdeIA } from "./ia.js";
import { interpretarMensajeParaFlujo } from "./Utils/creadorFlujos.js";
import fs from "fs";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
const PORT = process.env.PORT ?? 3008;
const PHONE_OWNER = process.env.PHONE_OWNER;
const LOCAL_API_URL = `http://localhost:${PORT}/v1/messages`;
const contactoFlow = addKeyword("/authgoogle").addAction(async (ctx, { flowDynamic, provider }) => {
    const phone = ctx.from;
    const host = ctx.host;
    const numeroNormalizadoPhone = phone.replace(/\D/g, "").slice(-10);
    const numeroNormalizadoHost = host.replace(/\D/g, "").slice(-10);
    console.log(`🔍 Validando autorización: phone=${numeroNormalizadoPhone}, host=${numeroNormalizadoHost}`);
    if (numeroNormalizadoPhone == numeroNormalizadoHost) {
        await handleAuthGoogle(ctx, flowDynamic);
    }
    else {
        await flowDynamic("❌ Este comando solo está disponible para el dueño del bot.");
    }
});
const pruebaFlow = addKeyword("/prueba").addAction(async () => {
    console.log("💥 Terminando proceso con código 1...");
    process.exit(1);
});
const activeFlow = addKeyword("/onoff").addAnswer([
    "🔧 *Configuración del bot*",
    "",
    "Envía los nuevos valores así:",
    "`Global Local Phone`",
    "",
    "*Phone* es opcional (se usará tu número si no lo pones)",
    "",
    "*Ejemplo:*\n`true false 5218112345678`",
].join("\n"), { capture: true }, async (ctx, { flowDynamic }) => {
    const partes = ctx.body.trim().split(/\s+/);
    if (partes.length < 2 || partes.length > 3) {
        return await flowDynamic("❌ Formato incorrecto. Escribe al menos dos valores: Global y Local. Opcionalmente puedes agregar un número.");
    }
    const [globalStr, localStr, phoneStr] = partes;
    const nuevoValorGlobal = globalStr === "true";
    const nuevoValorLocal = localStr === "true";
    await actualizarEstadoBot({
        ctx,
        nuevoValorGlobal,
        nuevoValorLocal,
        phone: phoneStr ?? ctx.from,
    });
    await flowDynamic("✅ Estado actualizado con éxito.");
});
export const chatFlow = addKeyword(EVENTS.ACTION)
    .addAction(async (ctx, { provider, flowDynamic }) => {
    const [, posibleNumero] = ctx.body.trim().split(/\s+/, 2);
    const phone = (posibleNumero ?? ctx.from).replace(/[^\d]/g, "");
    const filePath = await exportarChatCSV(phone);
    if (!filePath) {
        await flowDynamic("❌ No encontré mensajes para ese contacto.");
        return;
    }
    try {
        await provider.sendFile(ctx.key.remoteJid, filePath, `📄 Chat de ${phone}`);
        console.log(`📤 CSV enviado a ${ctx.from}: ${filePath}`);
    }
    catch (e) {
        console.error("❌ Error enviando CSV:", e);
        await flowDynamic("⚠️ No pude enviar el archivo. Vuelve a intentar.");
    }
});
export const tablasFlow = addKeyword("/datos").addAction(async (ctx, { provider, flowDynamic }) => {
    try {
        const filePath = await exportarTablasExcel();
        await provider.sendFile(ctx.key.remoteJid, filePath, "📊 Tablas del sistema");
        console.log(`✅ Excell enviado a ${ctx.from}: ${filePath}`);
    }
    catch (error) {
        console.error("❌ Error al generar/enviar archivo Excel:", error);
        await flowDynamic("⚠️ No pude generar el archivo. Intenta más tarde.");
    }
});
const main = async () => {
    const adapterFlow = createFlow([
        flowRouter,
        masterFlow,
        contactoFlow,
        activeFlow,
        chatFlow,
        tablasFlow,
        agendarCita,
        pruebaFlow,
    ]);
    const adapterProvider = createProvider(Provider, { writeMyself: "both" });
    const adapterDB = new Database();
    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    }, {
        queue: {
            timeout: 20000,
            concurrencyLimit: 50,
        },
    });
    adapterProvider.server.post("/v1/messages", handleCtx(async (bot, req, res) => {
        const { number, message, urlMedia } = req.body;
        await bot.sendMessage(number, message, { media: urlMedia ?? null });
        return res.end("sended");
    }));
    adapterProvider.server.post("/v1/register", handleCtx(async (bot, req, res) => {
        const { number, name } = req.body;
        await bot.dispatch("REGISTER_FLOW", { from: number, name });
        return res.end("trigger");
    }));
    adapterProvider.server.post("/v1/samples", handleCtx(async (bot, req, res) => {
        const { number, name } = req.body;
        await bot.dispatch("SAMPLES", { from: number, name });
        return res.end("trigger");
    }));
    adapterProvider.server.post("/v1/blacklist", handleCtx(async (bot, req, res) => {
        const { number, intent } = req.body;
        if (intent === "remove")
            bot.blacklist.remove(number);
        if (intent === "add")
            bot.blacklist.add(number);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "ok", number, intent }));
    }));
    adapterProvider.server.post("/v1/simular-chat", handleCtx(async (_bot, req, res) => {
        try {
            const { mensaje } = req.body;
            if (!mensaje || typeof mensaje !== "string") {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    error: "Se requiere el campo 'mensaje' como string.",
                }));
            }
            const resultado = await buscarFlujoDesdeIA(mensaje);
            console.log("🔍 Resultado de IA:", resultado);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(resultado));
        }
        catch (err) {
            console.error("❌ Error simulando chat:", err);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Error al procesar el mensaje con la IA." }));
        }
    }));
    adapterProvider.server.post("/v1/crear-flujo", handleCtx(async (_bot, req, res) => {
        try {
            const { mensaje } = req.body;
            const resultado = await interpretarMensajeParaFlujo(mensaje);
            const responsePayload = {
                finalizado: resultado.finalizado,
                respuesta: resultado.respuesta,
            };
            if (resultado.flujos) {
                responsePayload.flujos = resultado.flujos;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(responsePayload));
        }
        catch (err) {
            console.error("❌ Error interno en /v1/crear-flujo:", err);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                error: "Ocurrió un error interno al crear el flujo.",
            }));
        }
    }));
    adapterProvider.server.get("/v1/exportar-tablas", handleCtx(async (_bot, _req, res) => {
        try {
            const filePath = await exportarTablasExcel();
            res.writeHead(200, {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename=${path.basename(filePath)}`,
            });
            const fileStream = fs.createReadStream(filePath);
            fileStream.pipe(res);
        }
        catch (err) {
            console.error("❌ Error exportando tablas:", err);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No se pudo generar el archivo Excel" }));
        }
    }));
    adapterProvider.server.get("/v1/estado-bot", handleCtx(async (_bot, _req, res) => {
        try {
            const activo = await obtenerEstadoGlobalBot();
            const estado = activo ? "Activo" : "Apagado";
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ estado }));
        }
        catch (error) {
            console.error("❌ Error al obtener estado del bot:", error);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "No se pudo obtener el estado del bot." }));
        }
    }));
    adapterProvider.server.post("/oauth/token", async (req, res) => {
        const { tokens, bot_id } = req.body;
        if (!tokens || !bot_id) {
            if (typeof res.status === "function") {
                res.status(400).json({ error: "Faltan datos (tokens o bot_id)" });
            }
            else {
                console.error("❌ No se pudo enviar respuesta: res.status no es función");
            }
            return;
        }
        if (!tokens.refresh_token) {
            console.warn(`⚠️ Token sin refresh_token recibido para ${bot_id}, NO se guardará.`);
            console.log("🔎 Token recibido:", JSON.stringify(tokens, null, 2));
            if (typeof res.status === "function") {
                res.status(400).json({
                    error: "El token recibido no contiene refresh_token. Vuelve a autenticar con prompt=consent.",
                });
            }
            return;
        }
        try {
            console.log("🔐 Token recibido para bot:", bot_id);
            await guardarTokenEnDB(bot_id, tokens);
            if (typeof res.json === "function") {
                res.json({ status: "Token guardado con éxito" });
            }
            else {
                console.log("✅ Token guardado, pero res.json no está disponible.");
            }
        }
        catch (err) {
            console.error("❌ Error al guardar token:", err);
            if (typeof res.status === "function") {
                res.status(500).json({ error: "No se pudo guardar el token" });
            }
            else {
                console.error("❌ No se pudo enviar error al cliente: res.status no es función");
            }
        }
    });
    httpServer(+PORT);
    adapterProvider.on("ready", () => {
        mostrarEstadoBot();
    });
};
main();
