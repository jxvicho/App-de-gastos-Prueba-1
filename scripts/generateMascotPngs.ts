/**
 * One-off: rasteriza los SVG de public/assets/mascots/ a PNG de ~400x400px.
 * Los PNG (no los SVG) son los que se mandan por WhatsApp en el reporte
 * semanal — la Cloud API de Meta no acepta SVG en mensajes de tipo imagen.
 * Se corre a mano cada vez que un SVG de mascota cambia; no es parte del
 * runtime del backend (por eso @resvg/resvg-js vive en devDependencies).
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Resvg } from "@resvg/resvg-js";

const MASCOTS_DIR = join(__dirname, "..", "public", "assets", "mascots");
const PET_TYPES = ["dog", "cat", "capybara", "pig"];
const TARGET_SIZE = 400;

function main() {
  for (const petType of PET_TYPES) {
    const svgPath = join(MASCOTS_DIR, `${petType}.svg`);
    const pngPath = join(MASCOTS_DIR, `${petType}.png`);
    const svg = readFileSync(svgPath, "utf-8");

    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: TARGET_SIZE },
    });
    const pngBuffer = resvg.render().asPng();
    writeFileSync(pngPath, pngBuffer);
    console.log(`✅ ${petType}.svg -> ${petType}.png`);
  }
}

main();
