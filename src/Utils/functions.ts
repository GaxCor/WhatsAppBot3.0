import { getConnection } from "~/db/mysql";
import { getFunctionConfig } from "./configManager";
import { toZonedTime } from "date-fns-tz";
import fs from "fs";
import path from "path";
import os from "os";

type Source = "BOT" | "CLT" | "WHA";

interface GuardarDatosArgs {
  phone: string;
  name?: string;
  detalles?: string;
  message?: string;
  fromMe?: boolean;
  source?: Source; // 👈 Agregado para permitir uso manual de "BOT"
  messageId?: string;
  timestamp?: number;
}

/**
 * Convierte una fecha a UTC tomando como referencia la zona horaria de Monterrey
 */
const toMonterreyBasedUTC = (fecha: number | Date): Date => {
  const timeZone = "America/Monterrey";
  const baseDate = typeof fecha === "number" ? new Date(fecha) : fecha;
  const localDate = toZonedTime(baseDate, timeZone);
  return new Date(localDate.getTime());
};

export const guardarEnBaseDeDatos = async ({
  phone,
  name = "",
  detalles = "",
  message,
  fromMe = false,
  source,
  messageId = null,
  timestamp = Date.now(),
}: GuardarDatosArgs) => {
  const config = getFunctionConfig("guardarEnBaseDeDatos");

  if (!config?.enabled) {
    console.log(
      "⚠️ Función 'guardarEnBaseDeDatos' deshabilitada por configuración."
    );
    return;
  }

  const conn = await getConnection();

  try {
    // 1. Verificar si el usuario ya existe
    const [usuarios] = await conn.execute(
      "SELECT id FROM usuarios WHERE phone = ?",
      [phone]
    );

    let usuarioId: number;

    if ((usuarios as any[]).length > 0) {
      usuarioId = (usuarios as any[])[0].id;

      if (name || detalles) {
        await conn.execute(
          "UPDATE usuarios SET name = ?, detalles = ? WHERE id = ?",
          [name, detalles, usuarioId]
        );
      }
    } else {
      const [result] = await conn.execute(
        `INSERT INTO usuarios (name, phone, detalles, state, NOTRESTART)
         VALUES (?, ?, ?, true, false)`,
        [name, phone, detalles]
      );
      usuarioId = (result as any).insertId;
    }

    // 2. Guardar mensaje si existe
    if (message) {
      const fechaUTC = toMonterreyBasedUTC(timestamp);
      const finalSource: Source = source ?? (fromMe ? "WHA" : "CLT"); // ✅ Lógica priorizada

      await conn.execute(
        `INSERT INTO mensajes (usuario_id, message, sender, message_id, date)
         VALUES (?, ?, ?, ?, ?)`,
        [usuarioId, message, finalSource, messageId, fechaUTC]
      );
    }

    await conn.end();
  } catch (error) {
    console.error("❌ Error guardando en MySQL:", error);
    await conn.end();
    throw error;
  }
};

/**
 * Agrega un texto personalizado (por defecto "> CHATBOT") al final de cada mensaje
 * si está habilitado en config.functions.json
 */
export const formatearMensajeBot = (mensajes: string | string[]): string[] => {
  const config = getFunctionConfig("etiquetaChatbot");

  if (!config?.enabled) {
    return Array.isArray(mensajes) ? mensajes : [mensajes];
  }

  const textoEtiqueta = config.texto ?? "> CHATBOT";
  const mensajesArray = Array.isArray(mensajes) ? mensajes : [mensajes];
  const resultadoFinal: string[] = [];

  for (const mensaje of mensajesArray) {
    if (mensaje.length > 120 && mensaje.includes(". ")) {
      const partes = mensaje.split(/(?<=\.)\s+/);
      const ultimasPartes = partes.slice(0, -1).map((p) => p.trim());
      const ultima = partes[partes.length - 1].trim() + `\n${textoEtiqueta}`;
      resultadoFinal.push(...ultimasPartes, ultima);
    } else {
      resultadoFinal.push(`${mensaje}\n${textoEtiqueta}`);
    }
  }

  return resultadoFinal;
};

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const formatearMensajeBotConDelay = async (
  mensajes: string | string[],
  callback: (msg: string) => Promise<void>
) => {
  const mensajesFormateados = formatearMensajeBot(mensajes);
  for (const msg of mensajesFormateados) {
    await callback(msg);
    const delay = Math.floor(Math.random() * 500) + 500;
    await sleep(delay);
  }
};

/**
 * Envía un mensaje del bot y lo guarda en la base como 'BOT'.
 */
interface MensajeBOTParams {
  ctx: any;
  flowDynamic: (msg: string | string[]) => Promise<void>;
  mensaje: string | string[];
}

export const mensajeBOT = async ({
  ctx,
  flowDynamic,
  mensaje,
}: MensajeBOTParams) => {
  if (ctx.key.fromMe) return;
  // 2. Guardar cada mensaje como mensaje de BOT
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

export const verificarEstadoBot = async (phone: string): Promise<boolean> => {
  const conn = await getConnection();
  const iconoEstado = (activo: boolean): string => (activo ? "🟢" : "🔴");
  try {
    // 1. Estado global
    const [globalRows] = await conn.execute(
      "SELECT activo FROM global_state WHERE id = 1"
    );
    const globalActivo = (globalRows as any[])[0]?.activo ?? false;

    // 2. Estado local por usuario
    const [usuarioRows] = await conn.execute(
      "SELECT state FROM usuarios WHERE phone = ?",
      [phone]
    );
    const localActivo = (usuarioRows as any[])[0]?.state ?? false;

    // 3. Mostrar estados con icono
    console.log(
      `🌐 Global: ${iconoEstado(
        globalActivo
      )} (${globalActivo}) | 👤 Local: ${iconoEstado(
        localActivo
      )} (${localActivo})`
    );
    await conn.end();
    return globalActivo && localActivo;
  } catch (error) {
    console.error("❌ Error verificando estado del bot:", error);
    await conn.end();
    return false;
  }
};

interface ActualizarEstadoParams {
  ctx: any;
  nuevoValorGlobal?: boolean;
  nuevoValorLocal?: boolean;
  phone?: string;
}

/**
 * Cambia el estado global y/o local del bot en la base de datos.
 * Si no se proporciona `phone`, usa ctx.from para el estado local.
 */
export const actualizarEstadoBot = async ({
  ctx,
  nuevoValorGlobal,
  nuevoValorLocal,
  phone,
}: ActualizarEstadoParams): Promise<void> => {
  const conn = await getConnection();

  try {
    // Cambiar estado global si se recibió
    if (typeof nuevoValorGlobal === "boolean") {
      await conn.execute("UPDATE global_state SET activo = ? WHERE id = 1", [
        nuevoValorGlobal,
      ]);
      console.log(`✅ Estado GLOBAL actualizado a: ${nuevoValorGlobal}`);
    }

    // Cambiar estado local si se recibió
    if (typeof nuevoValorLocal === "boolean") {
      const numero = phone ?? ctx?.from;
      if (!numero) {
        console.warn(
          "⚠️ No se proporcionó número de teléfono para cambiar estado local."
        );
      } else {
        await conn.execute("UPDATE usuarios SET state = ? WHERE phone = ?", [
          nuevoValorLocal,
          numero,
        ]);
        console.log(
          `✅ Estado LOCAL para ${numero} actualizado a: ${nuevoValorLocal}`
        );
      }
    }

    await conn.end();
  } catch (error) {
    console.error("❌ Error actualizando estado del bot:", error);
    await conn.end();
    throw error;
  }
};

export const obtenerHistorial = async (phone: string): Promise<string[]> => {
  const config = getFunctionConfig("historialIA");
  if (!config?.enabled) return [];

  const cantidad =
    typeof config.cantidad === "number" && config.cantidad > 0
      ? config.cantidad
      : 5;

  const conn = await getConnection();
  try {
    const [rows] = await conn.execute(
      `
      SELECT message, sender FROM mensajes 
      INNER JOIN usuarios ON mensajes.usuario_id = usuarios.id
      WHERE usuarios.phone = ?
      ORDER BY mensajes.date DESC
      LIMIT ${cantidad}
      `,
      [phone]
    );

    await conn.end();

    const historial = (rows as any[])
      .reverse() // más antiguo primero
      .map((r) => `${r.sender === "CLT" ? "Cliente" : "Bot"}: ${r.message}`);

    return historial;
  } catch (err) {
    console.error("❌ Error al obtener historial:", err);
    await conn.end();
    return [];
  }
};

/**
 * Envía señales de presencia (ej. typing, recording) si está habilitado en config.functions.json
 */
export const enviarPresenciaSiActiva = async (
  provider: any,
  remoteJid: string
) => {
  const config = getFunctionConfig("presenciaIA");
  if (!config?.enabled) return;

  const tipo = config.tipo ?? "composing"; // composing | recording | paused

  try {
    await provider.vendor.sendPresenceUpdate(tipo, remoteJid);

    // Espera entre 1 y 3 segundos de forma aleatoria
    const delay = Math.floor(Math.random() * 2000) + 1000; // 1000ms a 3000ms
    await new Promise((res) => setTimeout(res, delay));
  } catch (error) {
    console.error("❌ Error al enviar presencia:", error);
  }
};

export async function exportarChatCSV(phone: string): Promise<string | null> {
  /* 1. Lee historial ------------------------------------------------------ */
  const conn = await getConnection();
  const [rows]: any = await conn.execute(
    `SELECT m.message, m.sender, m.date
       FROM mensajes m
       INNER JOIN usuarios u ON u.id = m.usuario_id
      WHERE u.phone LIKE ?
      ORDER BY m.date ASC`,
    [`%${phone.replace(/\D/g, "").slice(-10)}`]
  );
  await conn.end();

  if (!rows.length) return null;

  /* 2. Crea CSV ----------------------------------------------------------- */
  const encabezado = "fecha_iso,sender,mensaje";
  const cuerpo = rows
    .map((r: any) => {
      const fecha = r.date;
      const sender = r.sender;
      const msg = String(r.message).replace(/"/g, '""');
      return `"${fecha}","${sender}","${msg}"`;
    })
    .join("\n");

  const csv = `${encabezado}\n${cuerpo}`;

  /* 3. Carpeta temporal segura (cross-platform) -------------------------- */
  const dirTmp = path.join(os.tmpdir(), "nacho_bot");
  if (!fs.existsSync(dirTmp)) fs.mkdirSync(dirTmp, { recursive: true });

  const fileName = `chat_${phone}_${Date.now()}.csv`;
  const filePath = path.join(dirTmp, fileName);

  fs.writeFileSync(filePath, csv, "utf8");
  return filePath;
}
