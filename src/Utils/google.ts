import dotenv from "dotenv";
import fetch from "node-fetch";
import { getConnection } from "~/db/mysql";
import { google } from "googleapis";
import { getFunctionConfig } from "~/Utils/configManager";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const DB_NAME = process.env.DB_NAME!;
const BOT_URL = process.env.BOT_URL!;
const GETURL_API =
  "https://v539peby84.execute-api.us-east-2.amazonaws.com/lambda/GetCloudflareURLLambda";
const TOKEN_TRADER_API = "https://auth.newgiro.com";
// === Leer credenciales desde credentials.json ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const credentialsPath = path.resolve(__dirname, "../Utils/credentials.json");
const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));

const CLIENT_ID = credentials.web.client_id;
const CLIENT_SECRET = credentials.web.client_secret;
const REDIRECT_URI = credentials.web.redirect_uris[0];
const PORT = process.env.PORT ?? 3008;

/**
 * Registra la instancia ante TokenTrader. Si es 'bot_nacho', también se envía la URL.
 */
export const registrarInstancia = async (bot_id: string): Promise<void> => {
  const payload =
    DB_NAME === "bot_nacho"
      ? { bot_id, instance_name: DB_NAME, url: BOT_URL }
      : { bot_id, instance_name: DB_NAME };

  try {
    const res = await fetch(`${TOKEN_TRADER_API}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Registro fallido: ${msg}`);
    }

    console.log("📡 Instancia registrada exitosamente:", payload);
  } catch (err) {
    console.error("❌ Error registrando instancia:", err);
  }
};

/**
 * Obtiene la URL del bot. Si es 'bot_nacho' devuelve directamente BOT_URL.
 */
export const obtenerURLBot = async (): Promise<string | null> => {
  if (DB_NAME === "bot_nacho") {
    console.log("🔁 Usando BOT_URL local para bot_nacho");
    return BOT_URL;
  }

  try {
    const res = await fetch(GETURL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_name: DB_NAME, url: "true" }),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Fallo al obtener URL: ${msg}`);
    }

    const data = (await res.json()) as { url?: string };
    return data?.url ?? null;
  } catch (err) {
    console.error("❌ Error obteniendo URL:", err);
    return null;
  }
};

/**
 * Genera el link de autenticación de Google con el bot_id como state.
 */
export const generarAuthLink = (bot_id: string): string => {
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/contacts&access_type=offline&prompt=consent&state=${bot_id}`;
};

/**
 * Guarda el token en la base de datos con una clave única por bot.
 */
export async function guardarTokenEnDB(
  bot_id: string,
  tokens: any
): Promise<void> {
  if (!tokens?.access_token || !tokens?.refresh_token) {
    console.warn(
      `⚠️ Token rechazado para guardar: ${bot_id} (falta refresh_token)`
    );
    return;
  }

  const conn = await getConnection();
  await conn.execute(
    `REPLACE INTO infobot (nombre_var, valor_var) VALUES (?, ?)`,
    [`credenciales_google_${bot_id}`, JSON.stringify(tokens)]
  );
  await conn.end();

  console.log(`🗃️ Token guardado correctamente para ${bot_id}`);
}

export const handleAuthGoogle = async (ctx: any, flowDynamic: any) => {
  const phone = ctx.from;
  const host = ctx.host;
  const numeroNormalizadoPhone = phone.replace(/\D/g, "").slice(-10);
  const numeroNormalizadoHost = host.replace(/\D/g, "").slice(-10);
  // Validar que el usuario sea el mismo que el host
  console.log(
    `🔍 Validando autorización: phone=${numeroNormalizadoPhone}, host=${numeroNormalizadoHost}`
  );
  if (numeroNormalizadoPhone !== numeroNormalizadoHost) {
    await flowDynamic(
      "❌ Este comando solo está disponible para el dueño del bot."
    );
    return;
  }

  await registrarInstancia(phone);

  const url = await obtenerURLBot();
  if (!url) {
    await flowDynamic("❌ No se pudo obtener la URL del bot.");
    return;
  }

  const authUrl = generarAuthLink(phone);
  //console.log(`🔗 Link de autorización para ${phone}:\n${authUrl}`);

  // try {
  //   await fetch(LOCAL_API_URL, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({
  //       number: PHONE_OWNER,
  //       message: `📩 Solicitud de contacto: *${phone}*\n\n🔗 ${authUrl}`,
  //     }),
  //   });
  // } catch (err) {
  //   console.error("❌ Error enviando mensaje al dueño del bot vía API:", err);
  // }

  // await flowDynamic("✅ Enviamos tu solicitud. Te avisaremos pronto.");
  await flowDynamic([
    "📩 Aquí tienes tu enlace de autorización con Google:",
    `🔗 ${authUrl}`,
    "✅ Usa este enlace para vincular tu cuenta.",
  ]);
};

/* ---------------- utils ---------------------------------------- */
export const normalizarUltimos10 = (n: string) =>
  n.replace(/\D/g, "").slice(-10);

/* --------------------------------------------------------------- */
/*  CACHÉ por bot  (libreta completa)                              */
/* --------------------------------------------------------------- */
type CacheItem = { ts: number; numeros10: Set<string> };
const cacheGoogle: Record<string, CacheItem> = {};
const TTL_MIN = 15; //  ⬅️  cámbialo a tu gusto
const TTL_MS = TTL_MIN * 60_000;

/* --------------------------------------------------------------- */
/*  DESCARGA la libreta o devuelve la de caché                     */
/* --------------------------------------------------------------- */
async function obtenerSetGoogle(bot_id: string): Promise<Set<string>> {
  const now = Date.now();
  const item = cacheGoogle[bot_id];

  if (item && now - item.ts < TTL_MS) {
    const faltan = Math.round((TTL_MS - (now - item.ts)) / 1000);
    console.log(
      `⏳ Caché Google => faltan ${faltan}s para refrescar (${bot_id})`
    );
    return item.numeros10; // hit de caché
  }

  /* ---------------- descarga completa ------------------------- */
  const connTok = await getConnection();
  const [tok]: any = await connTok.execute(
    `SELECT valor_var FROM infobot WHERE nombre_var = ?`,
    [`credenciales_google_${bot_id}`]
  );
  await connTok.end();
  if (!tok.length) return new Set();

  const tokens = JSON.parse(tok[0].valor_var);
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oauth2.setCredentials(tokens);
  const people = google.people({ version: "v1", auth: oauth2 });

  const set = new Set<string>();
  let next: string | undefined;
  do {
    const res = await people.people.connections.list({
      resourceName: "people/me",
      personFields: "phoneNumbers",
      pageSize: 1000,
      pageToken: next,
    });
    for (const c of res.data.connections ?? []) {
      for (const tel of c.phoneNumbers ?? []) {
        set.add(normalizarUltimos10(tel.value ?? ""));
      }
    }
    next = res.data.nextPageToken ?? undefined;
  } while (next);

  cacheGoogle[bot_id] = { ts: now, numeros10: set };
  console.log(
    `🔄 Libreta Google actualizada (${bot_id}), contactos: ${set.size}`
  );
  return set;
}

/* --------------------------------------------------------------- */
/*  VERIFICA si el número existe (usa caché + TTL)                 */
/* --------------------------------------------------------------- */
export async function existeNumeroEnContactos(
  bot_id: string,
  numero: string
): Promise<boolean> {
  if (!getFunctionConfig("guardarContactoEnGoogle")?.enabled) return false;
  const setGoogle = await obtenerSetGoogle(bot_id);
  return setGoogle.has(normalizarUltimos10(numero));
}

/* --------------------------------------------------------------- */
/*  GUARDA si NO está ni en BD ni en Google                        */
/* --------------------------------------------------------------- */
export async function guardarContactoEnGoogle(
  bot_id: string,
  nombre: string,
  numero: string
) {
  if (!getFunctionConfig("guardarContactoEnGoogle")?.enabled) return;

  const num10 = normalizarUltimos10(numero);

  /* 1️⃣ BD local ------------------------------------------------- */
  const connBD = await getConnection();
  const [u]: any = await connBD.execute(
    `SELECT id, guardado_google FROM usuarios WHERE phone LIKE ? LIMIT 1`,
    [`%${num10}`]
  );
  await connBD.end();
  const idUsr = u.length ? u[0].id : null;

  /* 2️⃣ Google (con caché) -------------------------------------- */
  const setGoogle = await obtenerSetGoogle(bot_id);
  const flagGoogle = setGoogle.has(num10);

  /* 3️⃣ Sincroniza columna guardado_google ---------------------- */
  if (idUsr) {
    const connSync = await getConnection();
    await connSync.execute(
      `UPDATE usuarios SET guardado_google = ? WHERE id = ?`,
      [flagGoogle ? 1 : 0, idUsr]
    );
    await connSync.end();
  }

  /* 4️⃣ Si ya existe en Google → salir -------------------------- */
  if (flagGoogle) {
    console.log("🟡 Ya existía en Google:", numero);
    return;
  }

  /* 5️⃣ Crear contacto ------------------------------------------ */
  const connTok = await getConnection();
  const [tok]: any = await connTok.execute(
    `SELECT valor_var FROM infobot WHERE nombre_var = ?`,
    [`credenciales_google_${bot_id}`]
  );
  await connTok.end();
  if (!tok.length) return;

  const tokens = JSON.parse(tok[0].valor_var);
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oauth2.setCredentials(tokens);
  const people = google.people({ version: "v1", auth: oauth2 });

  try {
    await people.people.createContact({
      requestBody: {
        names: [{ givenName: nombre }],
        phoneNumbers: [{ value: numero }],
      },
    });

    /* añade al set en caché para que quede coherente */
    setGoogle.add(num10);

    if (idUsr) {
      const connUpd = await getConnection();
      await connUpd.execute(
        `UPDATE usuarios SET guardado_google = 1 WHERE id = ?`,
        [idUsr]
      );
      await connUpd.end();
    }

    console.log(`✅ Contacto creado: ${nombre} - ${numero}`);
  } catch (e) {
    console.error("❌ Error creando contacto:", e);
  }
}
