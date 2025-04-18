// src/Utils/configManager.ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ✅ Convertimos la ruta actual
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config.functions.json"), "utf-8")
);

export const getFunctionConfig = (key: string) => {
  const entry = config[key];
  if (entry === undefined) return { enabled: false };
  if (typeof entry === "boolean") return { enabled: entry };
  return entry;
};

export const reloadConfig = () => {
  config = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "config.functions.json"),
      "utf-8"
    )
  );
};
