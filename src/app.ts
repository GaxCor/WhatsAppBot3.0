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
import { guardarEnBaseDeDatos } from "./Utils/functions";

const PORT = process.env.PORT ?? 3008;

const welcomeFlow = addKeyword<Provider, Database>([
  EVENTS.WELCOME,
  EVENTS.VOICE_NOTE,
  EVENTS.TEMPLATE,
  EVENTS.ORDER,
  EVENTS.MEDIA,
  EVENTS.LOCATION,
  EVENTS.DOCUMENT,
  EVENTS.CALL,
  EVENTS.ACTION,
])
  .addAnswer(`🙌 Hello welcome to this *Chatbot*`)
  .addAction(async (ctx) => {
    // Guardar mensaje en la base de datos
    await guardarEnBaseDeDatos({
      source: "CLT", // puedes cambiar a "WHA" si es Webhook o según lógica
      phone: ctx.from,
      message: ctx.body,
      name: ctx.name, // si tienes un flujo para capturar nombre, pásalo aquí
      messageId: ctx.key?.id ?? null,
      timestamp: ctx.timestamp ? ctx.timestamp * 1000 : Date.now(),
    });
  });

const main = async () => {
  const adapterFlow = createFlow([welcomeFlow]);

  const adapterProvider = createProvider(Provider);
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

  httpServer(+PORT);
};

main();
