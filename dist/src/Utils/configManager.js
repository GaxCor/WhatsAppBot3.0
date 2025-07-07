import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.functions.json"), "utf-8"));
export const getFunctionConfig = (key) => {
    const entry = config[key];
    if (entry === undefined)
        return { enabled: false };
    if (typeof entry === "boolean")
        return { enabled: entry };
    return entry;
};
export const reloadConfig = () => {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.functions.json"), "utf-8"));
};
