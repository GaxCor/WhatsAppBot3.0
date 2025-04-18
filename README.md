# 📘 Documentación de Funciones del ChatBot (Versión Inicial)

Todas las funciones están escritas en **TypeScript** siguiendo la convención `camelCase`.

El sistema utiliza un archivo `config.json` para controlar de forma dinámica si una función está habilitada, deshabilitada, o si tiene parámetros adicionales (como límite de historial).

---

## ✅ Tabla de Funciones

| ID   | Nombre de Función     | Descripción                                                                                                                 | Argumentos                                                | Configuración (`config.json`)                                                  |
| ---- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| F001 | `verificarEstadoBot`  | Verifica si el bot está activo globalmente y para un número específico. Devuelve una tupla `[activoGlobal, activoUsuario]`. | `numero: string`                                          | `"verificarEstadoBot": true`                                                   |
| F002 | `guardarConversacion` | Guarda el mensaje recibido en el historial de conversación del contacto.                                                    | `numero: string`, `mensaje: string`, `timestamp?: number` | `"guardarConversacion": { "enabled": true, "limite": 10 }`                     |
| F003 | `guardarContacto`     | Guarda el contacto si aún no ha sido registrado. Puede actualizar nombre o estado si ya existe.                             | `numero: string`, `nombre?: string`                       | `"guardarContacto": true`                                                      |
| F004 | `responderConIA`      | Envía el historial de mensajes a OpenAI y devuelve la respuesta generada.                                                   | `numero: string`, `historial: Mensaje[]`                  | `"responderConIA": { "enabled": true, "modelo": "gpt-4", "maxHistorial": 10 }` |

---

## 🛠️ Tipado sugerido (TypeScript)

```ts
type EstadoBot = [boolean, boolean];

interface Mensaje {
  mensaje: string;
  rol: "user" | "assistant";
}
```
