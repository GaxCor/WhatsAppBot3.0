import { join } from "path";
import {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  utils,
  EVENTS,
} from "@builderbot/bot";
import { MemoryDB as Database } from "@builderbot/bot";
import { BaileysProvider as Provider } from "@builderbot/provider-baileys";
import {
  actualizarEstadoBot,
  exportarChatCSV,
  exportarTablasExcel,
  guardarEnBaseDeDatos,
  mensajeBOT,
  verificarEstadoBot,
} from "./Utils/functions";
import {
  existeNumeroEnContactos,
  generarAuthLink,
  guardarContactoEnGoogle,
  guardarTokenEnDB,
  handleAuthGoogle,
  obtenerURLBot,
  registrarInstancia,
} from "./Utils/google";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { flowRouter, masterFlow } from "./Flows/flows";
import { mostrarEstadoBot } from "./Utils/mostrarEstadoConfig";
import { buscarFlujoDesdeIA } from "./ia";
import { interpretarMensajeParaFlujo } from "./Utils/creadorFlujos";

dotenv.config();

const PORT = process.env.PORT ?? 3008;
const PHONE_OWNER = process.env.PHONE_OWNER!;
const LOCAL_API_URL = `http://localhost:${PORT}/v1/messages`;

const contactoFlow = addKeyword<Provider, Database>("/authgoogle").addAction(
  async (ctx, { flowDynamic, provider }) => {
    await handleAuthGoogle(ctx, flowDynamic);
  }
);

const activeFlow = addKeyword<Provider, Database>("/onoff").addAnswer(
  [
    "🔧 *Configuración del bot*",
    "",
    "Envía los nuevos valores así:",
    "`Global Local Phone`",
    "",
    "*Phone* es opcional (se usará tu número si no lo pones)",
    "",
    "*Ejemplo:*\n`true false 5218112345678`",
  ].join("\n"),
  { capture: true },
  async (ctx, { flowDynamic }) => {
    const partes = ctx.body.trim().split(/\s+/);

    if (partes.length < 2 || partes.length > 3) {
      return await flowDynamic(
        "❌ Formato incorrecto. Escribe al menos dos valores: Global y Local. Opcionalmente puedes agregar un número."
      );
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
  }
);

export const chatFlow = addKeyword<Provider, Database>(EVENTS.ACTION) // ← aquí SÓLO ACTION
  .addAction(async (ctx, { provider, flowDynamic }) => {
    /* ─── 1. Tomamos el número (si lo hubo) ─────────────────────────── */
    const [, posibleNumero] = ctx.body.trim().split(/\s+/, 2); // “/chat” [num?]
    const phone = (posibleNumero ?? ctx.from).replace(/[^\d]/g, ""); // deja sólo dígitos

    /* ─── 2. Creamos CSV ────────────────────────────────────────────── */
    const filePath = await exportarChatCSV(phone);

    if (!filePath) {
      await flowDynamic("❌ No encontré mensajes para ese contacto.");
      return;
    }

    /* ─── 3. Enviamos archivo al chat donde se pidió ────────────────── */
    try {
      await provider.sendFile(
        ctx.key.remoteJid, // a quien lo solicitó
        filePath,
        `📄 Chat de ${phone}`
      );
      console.log(`📤 CSV enviado a ${ctx.from}: ${filePath}`);
    } catch (e) {
      console.error("❌ Error enviando CSV:", e);
      await flowDynamic("⚠️ No pude enviar el archivo. Vuelve a intentar.");
    }
  });

export const tablasFlow = addKeyword<Provider, Database>("/datos").addAction(
  async (ctx, { provider, flowDynamic }) => {
    try {
      const filePath = await exportarTablasExcel();

      await provider.sendFile(
        ctx.key.remoteJid,
        filePath,
        "📊 Tablas del sistema"
      );

      console.log(`✅ Excell enviado a ${ctx.from}: ${filePath}`);
    } catch (error) {
      console.error("❌ Error al generar/enviar archivo Excel:", error);
      await flowDynamic("⚠️ No pude generar el archivo. Intenta más tarde.");
    }
  }
);

const main = async () => {
  const adapterFlow = createFlow([
    flowRouter,
    masterFlow,
    contactoFlow,
    activeFlow,
    chatFlow,
    tablasFlow,
  ]);

  const adapterProvider = createProvider(Provider, { writeMyself: "both" });
  const adapterDB = new Database();

  const { handleCtx, httpServer } = await createBot(
    {
      flow: adapterFlow,
      provider: adapterProvider,
      database: adapterDB,
    },
    {
      queue: {
        timeout: 20000,
        concurrencyLimit: 50,
      },
    }
  );

  adapterProvider.server.post(
    "/v1/messages",
    handleCtx(async (bot, req, res) => {
      const { number, message, urlMedia } = req.body;
      await bot.sendMessage(number, message, { media: urlMedia ?? null });
      return res.end("sended");
    })
  );

  adapterProvider.server.post(
    "/v1/register",
    handleCtx(async (bot, req, res) => {
      const { number, name } = req.body;
      await bot.dispatch("REGISTER_FLOW", { from: number, name });
      return res.end("trigger");
    })
  );

  adapterProvider.server.post(
    "/v1/samples",
    handleCtx(async (bot, req, res) => {
      const { number, name } = req.body;
      await bot.dispatch("SAMPLES", { from: number, name });
      return res.end("trigger");
    })
  );

  adapterProvider.server.post(
    "/v1/blacklist",
    handleCtx(async (bot, req, res) => {
      const { number, intent } = req.body;
      if (intent === "remove") bot.blacklist.remove(number);
      if (intent === "add") bot.blacklist.add(number);

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", number, intent }));
    })
  );

  adapterProvider.server.post(
    "/v1/simular-chat",
    handleCtx(async (_bot, req, res) => {
      try {
        const { mensaje } = req.body;

        if (!mensaje || typeof mensaje !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "Se requiere el campo 'mensaje' como string.",
            })
          );
        }

        const resultado = await buscarFlujoDesdeIA(mensaje);
        console.log("🔍 Resultado de IA:", resultado);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(resultado));
      } catch (err) {
        console.error("❌ Error simulando chat:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "Error al procesar el mensaje con la IA." })
        );
      }
    })
  );

  adapterProvider.server.post(
    "/v1/crear-flujo",
    handleCtx(async (_bot, req, res): Promise<void> => {
      try {
        const { mensaje } = req.body;
        const resultado = await interpretarMensajeParaFlujo(mensaje);

        const responsePayload: any = {
          finalizado: resultado.finalizado,
          respuesta: resultado.respuesta, // ← usamos "respuesta" en lugar de "mensaje"
        };

        if (resultado.flujos) {
          responsePayload.flujos = resultado.flujos;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(responsePayload));
      } catch (err) {
        console.error("❌ Error interno en /v1/crear-flujo:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: "Ocurrió un error interno al crear el flujo.",
          })
        );
      }
    })
  );

  adapterProvider.server.post("/oauth/token", async (req: any, res: any) => {
    const { tokens, bot_id } = req.body;

    if (!tokens || !bot_id) {
      if (typeof res.status === "function") {
        res.status(400).json({ error: "Faltan datos (tokens o bot_id)" });
      } else {
        console.error(
          "❌ No se pudo enviar respuesta: res.status no es función"
        );
      }
      return;
    }

    // ❗ Validación de seguridad: el token debe tener refresh_token
    if (!tokens.refresh_token) {
      console.warn(
        `⚠️ Token sin refresh_token recibido para ${bot_id}, NO se guardará.`
      );
      console.log("🔎 Token recibido:", JSON.stringify(tokens, null, 2));

      if (typeof res.status === "function") {
        res.status(400).json({
          error:
            "El token recibido no contiene refresh_token. Vuelve a autenticar con prompt=consent.",
        });
      }
      return;
    }

    try {
      console.log("🔐 Token recibido para bot:", bot_id);
      await guardarTokenEnDB(bot_id, tokens);

      if (typeof res.json === "function") {
        res.json({ status: "Token guardado con éxito" });
      } else {
        console.log("✅ Token guardado, pero res.json no está disponible.");
      }
    } catch (err) {
      console.error("❌ Error al guardar token:", err);

      if (typeof res.status === "function") {
        res.status(500).json({ error: "No se pudo guardar el token" });
      } else {
        console.error(
          "❌ No se pudo enviar error al cliente: res.status no es función"
        );
      }
    }
  });

  httpServer(+PORT);
  // ✅ Hora del reinicio
  adapterProvider.on("ready", () => {
    mostrarEstadoBot();
  });
};

main();
