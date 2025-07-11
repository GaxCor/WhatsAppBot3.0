import fs from "fs";
import path from "path";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { formatInTimeZone } from "date-fns-tz";
import { obtenerEstadoGlobalBot } from "./functions";

// Simula __dirname en módulos ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
chalk.level = 3; // Forzar colores completos (1=básico, 2=256, 3=16M)
const rutaConfig = path.join(__dirname, "../config.functions.json");

export const mostrarEstadoBot = () => {
  const zona = "America/Monterrey";
  const horaFormateada = formatInTimeZone(new Date(), zona, "HH:mm:ss");
  // const hora = new Date().toLocaleTimeString("es-MX", {
  //   hour: "2-digit",
  //   minute: "2-digit",
  //   second: "2-digit",
  // });

  console.log(`\nReinicio del bot a las ${horaFormateada}\n`);

  // Obtener e imprimir estado global
  try {
    const activo = obtenerEstadoGlobalBot();
    const estadoTexto = activo
      ? chalk.green.bold("ENCENDIDO")
      : chalk.red.bold("APAGADO");
    console.log(chalk.bold("Estado global del bot:"), estadoTexto, "\n");
  } catch (err) {
    console.log(chalk.red("❌ No se pudo obtener el estado global del bot\n"));
  }

  if (!fs.existsSync(rutaConfig)) {
    console.log(
      chalk.red("No se encontró el archivo config.functions.json en /src\n")
    );
    return;
  }

  try {
    const contenido = fs.readFileSync(rutaConfig, "utf-8");
    const config = JSON.parse(contenido);

    console.log(chalk.bold("Estado de funciones del bot:"));

    const imprimirEstado = (clave: string, valor: any) => {
      if (typeof valor === "boolean") {
        const texto = valor ? chalk.green("Activo") : chalk.red("Inactivo");
        console.log(`- ${clave}: ${texto}`);
      } else if (typeof valor === "object" && "enabled" in valor) {
        const texto = valor.enabled
          ? chalk.green("Activo")
          : chalk.red("Inactivo");
        console.log(`- ${clave}: ${texto}`);
      }
    };

    for (const clave in config) {
      imprimirEstado(clave, config[clave]);
    }

    console.log(); // Línea final
  } catch (error) {
    console.log(
      chalk.red("Error al leer o parsear el archivo config.functions.json\n")
    );
  }
};
