import { getConnection } from "~/db/mysql";
import { getFunctionConfig } from "./configManager.js";
import { toZonedTime } from "date-fns-tz";
import fs from "fs";
import path from "path";
import os from "os";
import * as XLSX from "xlsx";
import OpenAI from "openai";
const toMonterreyBasedUTC = (fecha) => {
    const timeZone = "America/Monterrey";
    const baseDate = typeof fecha === "number" ? new Date(fecha) : fecha;
    const localDate = toZonedTime(baseDate, timeZone);
    return new Date(localDate.getTime());
};
export const guardarEnBaseDeDatos = async ({ phone, name = "", detalles = "", message, fromMe = false, source, messageId = null, timestamp = Date.now(), }) => {
    const config = getFunctionConfig("guardarEnBaseDeDatos");
    if (!config?.enabled) {
        console.log("⚠️ Función 'guardarEnBaseDeDatos' deshabilitada por configuración.");
        return;
    }
    const conn = await getConnection();
    try {
        const [usuarios] = await conn.execute("SELECT id FROM usuarios WHERE phone = ?", [phone]);
        let usuarioId;
        if (usuarios.length > 0) {
            usuarioId = usuarios[0].id;
            if (name || detalles) {
                await conn.execute("UPDATE usuarios SET name = ?, detalles = ? WHERE id = ?", [name, detalles, usuarioId]);
            }
        }
        else {
            const [result] = await conn.execute(`INSERT INTO usuarios (name, phone, detalles, state, NOTRESTART)
         VALUES (?, ?, ?, true, false)`, [name, phone, detalles]);
            usuarioId = result.insertId;
        }
        if (message) {
            const fechaUTC = toMonterreyBasedUTC(timestamp);
            const finalSource = source ?? (fromMe ? "WHA" : "CLT");
            await conn.execute(`INSERT INTO mensajes (usuario_id, message, sender, message_id, date)
         VALUES (?, ?, ?, ?, ?)`, [usuarioId, message, finalSource, messageId, fechaUTC]);
        }
        await conn.end();
    }
    catch (error) {
        console.error("❌ Error guardando en MySQL:", error);
        await conn.end();
        throw error;
    }
};
export const formatearMensajeBot = (mensajes) => {
    const config = getFunctionConfig("etiquetaChatbot");
    if (!config?.enabled) {
        return Array.isArray(mensajes) ? mensajes : [mensajes];
    }
    const textoEtiqueta = config.texto ?? "> CHATBOT";
    const mensajesArray = Array.isArray(mensajes) ? mensajes : [mensajes];
    const resultadoFinal = [];
    for (const mensaje of mensajesArray) {
        if (mensaje.length > 120 && mensaje.includes(". ")) {
            const partes = mensaje.split(/(?<=\.)\s+/);
            const ultimasPartes = partes.slice(0, -1).map((p) => p.trim());
            const ultima = partes[partes.length - 1].trim() + `\n${textoEtiqueta}`;
            resultadoFinal.push(...ultimasPartes, ultima);
        }
        else {
            resultadoFinal.push(`${mensaje}\n${textoEtiqueta}`);
        }
    }
    return resultadoFinal;
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
export const formatearMensajeBotConDelay = async (mensajes, callback) => {
    const mensajesFormateados = formatearMensajeBot(mensajes);
    for (const msg of mensajesFormateados) {
        await callback(msg);
        const delay = Math.floor(Math.random() * 500) + 500;
        await sleep(delay);
    }
};
export const mensajeBOT = async ({ ctx, flowDynamic, mensaje, }) => {
    if (ctx.key.fromMe)
        return;
    const mensajesArray = Array.isArray(mensaje) ? mensaje : [mensaje];
    await formatearMensajeBotConDelay(mensaje, flowDynamic);
    for (const msg of mensajesArray) {
        await guardarEnBaseDeDatos({
            phone: ctx.from,
            message: msg,
            source: "BOT",
        });
    }
};
export const verificarEstadoBot = async (phone) => {
    const conn = await getConnection();
    const iconoEstado = (activo) => (activo ? "🟢" : "🔴");
    try {
        const [globalRows] = await conn.execute("SELECT activo FROM global_state WHERE id = 1");
        const globalActivo = globalRows[0]?.activo ?? false;
        const [usuarioRows] = await conn.execute("SELECT state FROM usuarios WHERE phone = ?", [phone]);
        const localActivo = usuarioRows[0]?.state ?? false;
        console.log(`🌐 Global: ${iconoEstado(globalActivo)} (${globalActivo}) | 👤 Local: ${iconoEstado(localActivo)} (${localActivo})`);
        await conn.end();
        return globalActivo && localActivo;
    }
    catch (error) {
        console.error("❌ Error verificando estado del bot:", error);
        await conn.end();
        return false;
    }
};
export const actualizarEstadoBot = async ({ ctx, nuevoValorGlobal, nuevoValorLocal, phone, }) => {
    const conn = await getConnection();
    try {
        if (typeof nuevoValorGlobal === "boolean") {
            await conn.execute("UPDATE global_state SET activo = ? WHERE id = 1", [
                nuevoValorGlobal,
            ]);
            console.log(`✅ Estado GLOBAL actualizado a: ${nuevoValorGlobal}`);
        }
        if (typeof nuevoValorLocal === "boolean") {
            const numero = phone ?? ctx?.from;
            if (!numero) {
                console.warn("⚠️ No se proporcionó número de teléfono para cambiar estado local.");
            }
            else {
                await conn.execute("UPDATE usuarios SET state = ? WHERE phone = ?", [
                    nuevoValorLocal,
                    numero,
                ]);
                console.log(`✅ Estado LOCAL para ${numero} actualizado a: ${nuevoValorLocal}`);
            }
        }
        await conn.end();
    }
    catch (error) {
        console.error("❌ Error actualizando estado del bot:", error);
        await conn.end();
        throw error;
    }
};
export const obtenerHistorial = async (phone) => {
    const config = getFunctionConfig("historialIA");
    if (!config?.enabled)
        return [];
    const cantidad = typeof config.cantidad === "number" && config.cantidad > 0
        ? config.cantidad
        : 5;
    const conn = await getConnection();
    try {
        const [rows] = await conn.execute(`
      SELECT message, sender FROM mensajes 
      INNER JOIN usuarios ON mensajes.usuario_id = usuarios.id
      WHERE usuarios.phone = ?
      ORDER BY mensajes.date DESC
      LIMIT ${cantidad}
      `, [phone]);
        await conn.end();
        const historial = rows
            .reverse()
            .map((r) => `${r.sender === "CLT" ? "Cliente" : "Bot"}: ${r.message}`);
        return historial;
    }
    catch (err) {
        console.error("❌ Error al obtener historial:", err);
        await conn.end();
        return [];
    }
};
export const enviarPresenciaSiActiva = async (provider, remoteJid) => {
    const config = getFunctionConfig("presenciaIA");
    if (!config?.enabled)
        return;
    const tipo = config.tipo ?? "composing";
    try {
        await provider.vendor.sendPresenceUpdate(tipo, remoteJid);
        const delay = Math.floor(Math.random() * 2000) + 1000;
        await new Promise((res) => setTimeout(res, delay));
    }
    catch (error) {
        console.error("❌ Error al enviar presencia:", error);
    }
};
export async function exportarChatCSV(phone) {
    const conn = await getConnection();
    const [rows] = await conn.execute(`SELECT m.message, m.sender, m.date
       FROM mensajes m
       INNER JOIN usuarios u ON u.id = m.usuario_id
      WHERE u.phone LIKE ?
      ORDER BY m.date ASC`, [`%${phone.replace(/\D/g, "").slice(-10)}`]);
    await conn.end();
    if (!rows.length)
        return null;
    const encabezado = "fecha_iso,sender,mensaje";
    const cuerpo = rows
        .map((r) => {
        const fecha = r.date;
        const sender = r.sender;
        const msg = String(r.message).replace(/"/g, '""');
        return `"${fecha}","${sender}","${msg}"`;
    })
        .join("\n");
    const csv = `${encabezado}\n${cuerpo}`;
    const dirTmp = path.join(os.tmpdir(), "nacho_bot");
    if (!fs.existsSync(dirTmp))
        fs.mkdirSync(dirTmp, { recursive: true });
    const fileName = `chat_${phone}_${Date.now()}.csv`;
    const filePath = path.join(dirTmp, fileName);
    fs.writeFileSync(filePath, csv, "utf8");
    return filePath;
}
export async function exportarTablasExcel() {
    const conn = await getConnection();
    try {
        const [flujos] = await conn.execute("SELECT * FROM flujos");
        const [globalState] = await conn.execute("SELECT * FROM global_state");
        const [infobot] = await conn.execute("SELECT * FROM infobot");
        const [usuarios] = await conn.execute("SELECT * FROM usuarios");
        const [mensajes] = await conn.execute("SELECT * FROM mensajes");
        await conn.end();
        const workbook = XLSX.utils.book_new();
        const agregarHoja = (nombre, datos) => {
            const worksheet = XLSX.utils.json_to_sheet(datos);
            XLSX.utils.book_append_sheet(workbook, worksheet, nombre);
        };
        agregarHoja("flujos", flujos);
        agregarHoja("global_state", globalState);
        agregarHoja("infobot", infobot);
        agregarHoja("usuarios", usuarios);
        agregarHoja("mensajes", mensajes);
        const tmpDir = path.join(os.tmpdir(), "nacho_bot");
        if (!fs.existsSync(tmpDir))
            fs.mkdirSync(tmpDir, { recursive: true });
        const filePath = path.join(tmpDir, `tablas_${Date.now()}.xlsx`);
        XLSX.writeFile(workbook, filePath);
        return filePath;
    }
    catch (error) {
        console.error("❌ Error exportando tablas a Excel:", error);
        throw error;
    }
}
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
export async function transcribirAudioDesdeMensaje(ctx, provider) {
    const tmpDir = path.join(os.tmpdir(), "nacho_bot_audio");
    if (!fs.existsSync(tmpDir))
        fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = await provider.saveFile(ctx, { path: tmpDir });
    const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
        response_format: "text",
        language: "es",
    });
    fs.unlink(filePath, () => { });
    return transcription;
}
