// src/Utils/guardarEnBaseDeDatos.ts

import { getConnection } from "~/db/mysql";
import { getFunctionConfig } from "./configManager";
import { toZonedTime } from "date-fns-tz";

type Source = "BOT" | "CLT" | "WHA";

interface GuardarDatosArgs {
  phone: string;
  name?: string;
  detalles?: string;
  source?: Source;
  message?: string;
  messageId?: string;
  timestamp?: number;
}

/**
 * Ajusta un timestamp a UTC como si viniera desde la hora local de Monterrey.
 */
const toMonterreyBasedUTC = (fecha: number | Date): Date => {
  const timeZone = "America/Monterrey";
  const baseDate = typeof fecha === "number" ? new Date(fecha) : fecha;

  const localDate = toZonedTime(baseDate, timeZone);
  return new Date(localDate.getTime());
};

/**
 * Guarda datos del usuario y mensaje en base de datos, ajustando fechas a hora de Monterrey.
 */
export const guardarEnBaseDeDatos = async ({
  phone,
  name = "",
  detalles = "",
  source,
  message,
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

    if (message && source) {
      const fechaUTC = toMonterreyBasedUTC(timestamp);
      await conn.execute(
        `INSERT INTO mensajes (usuario_id, message, sender, message_id, date)
         VALUES (?, ?, ?, ?, ?)`,
        [usuarioId, message, source, messageId, fechaUTC]
      );
    }

    await conn.end();
  } catch (error) {
    console.error("❌ Error guardando en MySQL:", error);
    await conn.end();
    throw error;
  }
};
