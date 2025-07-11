import fs from "fs";
import path from "path";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { formatInTimeZone } from "date-fns-tz";
import { obtenerEstadoGlobalBot } from "./functions.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
chalk.level = 3;
const rutaConfig = path.join(__dirname, "../config.functions.json");
export const mostrarEstadoBot = async () => {
    const zona = "America/Monterrey";
    const horaFormateada = formatInTimeZone(new Date(), zona, "HH:mm:ss");
    console.log(`\nReinicio del bot a las ${horaFormateada}\n`);
    if (!fs.existsSync(rutaConfig)) {
        console.log(chalk.red("No se encontró el archivo config.functions.json en /src\n"));
        return;
    }
    try {
        const contenido = fs.readFileSync(rutaConfig, "utf-8");
        const config = JSON.parse(contenido);
        console.log(chalk.bold("Estado de funciones del bot:"));
        const imprimirEstado = (clave, valor) => {
            if (typeof valor === "boolean") {
                const texto = valor ? chalk.green("Activo") : chalk.red("Desactivado");
                console.log(`- ${clave}: ${texto}`);
            }
            else if (typeof valor === "object" && "enabled" in valor) {
                const texto = valor.enabled
                    ? chalk.green("Activo")
                    : chalk.red("Desactivado");
                console.log(`- ${clave}: ${texto}`);
            }
        };
        for (const clave in config) {
            imprimirEstado(clave, config[clave]);
        }
        try {
            const activo = await obtenerEstadoGlobalBot();
            const estadoTexto = activo
                ? chalk.green.bold("ENCENDIDO")
                : chalk.red.bold("APAGADO");
            console.log(chalk.bold("Estado global del bot:"), estadoTexto, "\n");
        }
        catch (err) {
            console.log(chalk.red("❌ No se pudo obtener el estado global del bot\n"));
        }
        console.log();
    }
    catch (error) {
        console.log(chalk.red("Error al leer o parsear el archivo config.functions.json\n"));
    }
};
