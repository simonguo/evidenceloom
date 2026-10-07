// Scan a bound frontend export inventory with the selected Next configuration.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const [configPath, inputPath, outputPath] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (Object.keys(input).sort().join(",") !== "expectedInventorySha256,expectedSelection,inventory,outputDirectory") throw new Error("invalid export scanner request");
const { scanDesktopFrontendExportInventory } = await import(pathToFileURL(configPath).href);
const result = scanDesktopFrontendExportInventory(input);
fs.writeFileSync(outputPath, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
