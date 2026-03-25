#!/usr/bin/env node
/**
 * Pequeño helper CLI para descargar un manifiesto HLS (.m3u8) a MP4 usando ffmpeg.
 * Requiere ffmpeg instalado y disponible en PATH.
 *
 * Uso:
 *   node scripts/m3u8-to-mp4.js "<url_m3u8>" [salida.mp4]
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function printUsage() {
  console.log('Uso: node scripts/m3u8-to-mp4.js "<url_m3u8>" [salida.mp4]');
}

const m3u8Url = process.argv[2];
const output = process.argv[3] || "salida.mp4";

if (!m3u8Url) {
  printUsage();
  process.exit(1);
}

// Crea el directorio de salida si no existe
const outDir = path.dirname(output);
if (outDir && outDir !== "." && !fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// ffmpeg -i "<m3u8>" -c copy -bsf:a aac_adtstoasc salida.mp4
const args = ["-i", m3u8Url, "-c", "copy", "-bsf:a", "aac_adtstoasc", output];

console.log(`Ejecutando ffmpeg ${args.join(" ")}`);
const ffmpeg = spawn("ffmpeg", args, { stdio: "inherit" });

ffmpeg.on("error", (err) => {
  console.error("No se pudo ejecutar ffmpeg. ¿Está instalado y en PATH?", err.message);
  process.exit(1);
});

ffmpeg.on("exit", (code) => {
  if (code === 0) {
    console.log(`Listo: ${output}`);
  } else {
    console.error(`ffmpeg terminó con código ${code}.`);
  }
  process.exit(code);
});
