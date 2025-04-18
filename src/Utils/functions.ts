// src/utils/guardarEnBaseDeDatos.ts
import { getConnection } from "~/db/mysql";
import { getFunctionConfig } from "./configManager";

type Source = "BOT" | "CLT" | "WHA";

interface GuardarDatosArgs {
  source: Source;
  message: string;
  phone: string;
  name?: string;
  detalles?: string;
  messageId?: string;
  timestamp?: number;
}

export const guardarEnBaseDeDatos = async ({
  source,
  message,
  phone,
  name = "",
  detalles = "",
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
    // 1. Verificar si el usuario existe
    const [usuarios] = await conn.execute(
      "SELECT id FROM usuarios WHERE phone = ?",
      [phone]
    );

    let usuarioId: number;

    if ((usuarios as any[]).length > 0) {
      usuarioId = (usuarios as any[])[0].id;
    } else {
      const [result] = await conn.execute(
        `INSERT INTO usuarios (name, phone, detalles, state, NOTRESTART)
         VALUES (?, ?, ?, true, false)`,
        [name, phone, detalles]
      );
      usuarioId = (result as any).insertId;
    }

    // 2. Guardar mensaje
    await conn.execute(
      `INSERT INTO mensajes (usuario_id, message, sender, message_id, date)
       VALUES (?, ?, ?, ?, ?)`,
      [usuarioId, message, source, messageId, new Date(timestamp)]
    );

    await conn.end();
  } catch (error) {
    console.error("❌ Error guardando en MySQL:", error);
    await conn.end();
    throw error;
  }
};
