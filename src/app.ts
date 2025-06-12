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

const main = async () => {
  const adapterFlow = createFlow([
    flowRouter,
    masterFlow,
    contactoFlow,
    activeFlow,
  ]);

  const adapterProvider = createProvider(Provider, { writeMyself: "both" });
  const adapterDB = new Database();

  const { handleCtx, httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

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
