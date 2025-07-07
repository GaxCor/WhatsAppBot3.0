import dotenv from "dotenv";
import fetch from "node-fetch";
import { getConnection } from "../db/mysql.js";
import { google } from "googleapis";
import { getFunctionConfig } from "./configManager.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
dotenv.config();
const DB_NAME = process.env.DB_NAME;
const BOT_URL = process.env.BOT_URL;
const GETURL_API = "https://v539peby84.execute-api.us-east-2.amazonaws.com/lambda/GetCloudflareURLLambda";
const TOKEN_TRADER_API = "https://auth.newgiro.com";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const credentialsPath = path.resolve(__dirname, "../Utils/credentials.json");
const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
const CLIENT_ID = credentials.web.client_id;
const CLIENT_SECRET = credentials.web.client_secret;
const REDIRECT_URI = credentials.web.redirect_uris[0];
const PORT = process.env.PORT ?? 3008;
export const registrarInstancia = async (bot_id) => {
    const payload = DB_NAME === "bot_nacho"
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
    }
    catch (err) {
        console.error("❌ Error registrando instancia:", err);
    }
};
export const obtenerURLBot = async () => {
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
        const data = (await res.json());
        return data?.url ?? null;
    }
    catch (err) {
        console.error("❌ Error obteniendo URL:", err);
        return null;
    }
};
export const generarAuthLink = (bot_id) => {
    const scopes = [
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/calendar",
    ];
    const scopeParam = encodeURIComponent(scopes.join(" "));
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=${scopeParam}&access_type=offline&prompt=consent&state=${bot_id}`;
};
export async function guardarTokenEnDB(bot_id, tokens) {
    if (!tokens?.access_token || !tokens?.refresh_token) {
        console.warn(`⚠️ Token rechazado para guardar: ${bot_id} (falta refresh_token)`);
        return;
    }
    const conn = await getConnection();
    await conn.execute(`REPLACE INTO infobot (nombre_var, valor_var) VALUES (?, ?)`, [`credenciales_google_${bot_id}`, JSON.stringify(tokens)]);
    await conn.end();
    console.log(`🗃️ Token guardado correctamente para ${bot_id}`);
}
export const handleAuthGoogle = async (ctx, flowDynamic) => {
    const phone = ctx.from;
    await registrarInstancia(phone);
    const url = await obtenerURLBot();
    if (!url) {
        await flowDynamic("❌ No se pudo obtener la URL del bot.");
        return;
    }
    const authUrl = generarAuthLink(phone);
    await flowDynamic([
        "📩 Aquí tienes tu enlace de autorización con Google:",
        `🔗 ${authUrl}`,
        "✅ Usa este enlace para vincular tu cuenta.",
    ]);
};
export const normalizarUltimos10 = (n) => n.replace(/\D/g, "").slice(-10);
const cacheGoogle = {};
const TTL_MIN = 15;
const TTL_MS = TTL_MIN * 60_000;
async function obtenerSetGoogle(bot_id) {
    const now = Date.now();
    const item = cacheGoogle[bot_id];
    if (item && now - item.ts < TTL_MS) {
        const faltan = Math.round((TTL_MS - (now - item.ts)) / 1000);
        console.log(`⏳ Caché Google => faltan ${faltan}s para refrescar (${bot_id})`);
        return item.numeros10;
    }
    const connTok = await getConnection();
    const [tok] = await connTok.execute(`SELECT valor_var FROM infobot WHERE nombre_var = ?`, [`credenciales_google_${bot_id}`]);
    await connTok.end();
    if (!tok.length)
        return new Set();
    const tokens = JSON.parse(tok[0].valor_var);
    const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oauth2.setCredentials(tokens);
    const people = google.people({ version: "v1", auth: oauth2 });
    const set = new Set();
    let next;
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
    console.log(`🔄 Libreta Google actualizada (${bot_id}), contactos: ${set.size}`);
    return set;
}
export async function existeNumeroEnContactos(bot_id, numero) {
    if (!getFunctionConfig("guardarContactoEnGoogle")?.enabled)
        return false;
    const setGoogle = await obtenerSetGoogle(bot_id);
    return setGoogle.has(normalizarUltimos10(numero));
}
export async function guardarContactoEnGoogle(bot_id, nombre, numero) {
    if (!getFunctionConfig("guardarContactoEnGoogle")?.enabled)
        return;
    const num10 = normalizarUltimos10(numero);
    const connBD = await getConnection();
    const [u] = await connBD.execute(`SELECT id, guardado_google FROM usuarios WHERE phone LIKE ? LIMIT 1`, [`%${num10}`]);
    await connBD.end();
    const idUsr = u.length ? u[0].id : null;
    const setGoogle = await obtenerSetGoogle(bot_id);
    const flagGoogle = setGoogle.has(num10);
    if (idUsr) {
        const connSync = await getConnection();
        await connSync.execute(`UPDATE usuarios SET guardado_google = ? WHERE id = ?`, [flagGoogle ? 1 : 0, idUsr]);
        await connSync.end();
    }
    if (flagGoogle) {
        console.log("🟡 Ya existía en Google:", numero);
        return;
    }
    const connTok = await getConnection();
    const [tok] = await connTok.execute(`SELECT valor_var FROM infobot WHERE nombre_var = ?`, [`credenciales_google_${bot_id}`]);
    await connTok.end();
    if (!tok.length)
        return;
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
        setGoogle.add(num10);
        if (idUsr) {
            const connUpd = await getConnection();
            await connUpd.execute(`UPDATE usuarios SET guardado_google = 1 WHERE id = ?`, [idUsr]);
            await connUpd.end();
        }
        console.log(`✅ Contacto creado: ${nombre} - ${numero}`);
    }
    catch (e) {
        console.error("❌ Error creando contacto:", e);
    }
}
export async function agendarCitaEnGoogleCalendar(bot_id, resumen, descripcion, fechaInicio, fechaFin) {
    try {
        const conn = await getConnection();
        const [tok] = await conn.execute(`SELECT valor_var FROM infobot WHERE nombre_var = ?`, [`credenciales_google_${bot_id}`]);
        await conn.end();
        if (!tok.length) {
            console.warn("⚠️ No hay credenciales guardadas para el bot:", bot_id);
            return;
        }
        const tokens = JSON.parse(tok[0].valor_var);
        const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
        oauth2.setCredentials(tokens);
        const calendar = google.calendar({ version: "v3", auth: oauth2 });
        const res = await calendar.events.insert({
            calendarId: "primary",
            requestBody: {
                summary: resumen,
                description: descripcion,
                start: {
                    dateTime: fechaInicio,
                    timeZone: "America/Monterrey",
                },
                end: {
                    dateTime: fechaFin,
                    timeZone: "America/Monterrey",
                },
            },
        });
        console.log("📅 Evento agendado exitosamente:", res.data.htmlLink);
    }
    catch (e) {
        console.error("❌ Error al agendar cita en Google Calendar:", e);
    }
}
export async function obtenerTodasLasFechasDeCitas(bot_id) {
    try {
        const conn = await getConnection();
        const [tok] = await conn.execute(`SELECT valor_var FROM infobot WHERE nombre_var = ?`, [`credenciales_google_${bot_id}`]);
        await conn.end();
        if (!tok.length) {
            console.warn("⚠️ No hay credenciales guardadas para el bot:", bot_id);
            return [];
        }
        const tokens = JSON.parse(tok[0].valor_var);
        const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
        oauth2.setCredentials(tokens);
        const calendar = google.calendar({ version: "v3", auth: oauth2 });
        const eventos = [];
        let nextPageToken = undefined;
        do {
            const res = await calendar.events.list({
                calendarId: "primary",
                timeMin: new Date(2000, 0, 1).toISOString(),
                maxResults: 2500,
                singleEvents: true,
                orderBy: "startTime",
                pageToken: nextPageToken,
            });
            const items = res.data.items ?? [];
            items.forEach((evento) => {
                eventos.push({
                    resumen: evento.summary ?? "(sin título)",
                    fechaInicio: evento.start?.dateTime ?? evento.start?.date ?? "",
                    fechaFin: evento.end?.dateTime ?? evento.end?.date ?? "",
                    eventId: evento.id ?? "",
                });
            });
            nextPageToken = res.data.nextPageToken ?? undefined;
        } while (nextPageToken);
        console.log(`📅 ${eventos.length} eventos encontrados en total.`);
        return eventos;
    }
    catch (e) {
        console.error("❌ Error al obtener todas las fechas de citas:", e);
        return [];
    }
}
export async function eliminarCitaPorEventId(bot_id, eventId) {
    try {
        const conn = await getConnection();
        const [tok] = await conn.execute(`SELECT valor_var FROM infobot WHERE nombre_var = ?`, [`credenciales_google_${bot_id}`]);
        await conn.end();
        if (!tok.length) {
            console.warn("⚠️ No hay credenciales guardadas para el bot:", bot_id);
            return false;
        }
        const tokens = JSON.parse(tok[0].valor_var);
        const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
        oauth2.setCredentials(tokens);
        const calendar = google.calendar({ version: "v3", auth: oauth2 });
        await calendar.events.delete({
            calendarId: "primary",
            eventId,
        });
        console.log(`🗑️ Evento eliminado correctamente (${eventId})`);
        return true;
    }
    catch (e) {
        if (e?.code === 404) {
            console.log("❌ No se encontró la cita con ese eventId");
        }
        else {
            console.error("❌ Error al eliminar evento en Google Calendar:", e);
        }
        return false;
    }
}
