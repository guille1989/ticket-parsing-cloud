// Corre un parser contra un archivo capturado y muestra el resultado —
// para iterar rápido escribiendo o ajustando un parser nuevo sin tener
// que desplegar nada. No es parte del stack.
//
// Uso:
//   npx tsx scripts/test-parser.ts --parser example-38col --file ../print-capture-agent/data/captures/xxx.bin
//   cat ticket.txt | npx tsx scripts/test-parser.ts --parser example-38col
//
// --encoding (default latin1) controla cómo se decodifican los bytes del
// archivo — latin1 es lo que ya usa `portCapture.ts` del lado del agente,
// mantenerlo consistente acá para probar con el mismo criterio.
import { readFileSync } from "node:fs";

import { getParser } from "../src/parsing/registry.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readStdin(): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function main(): Promise<void> {
  const parserId = arg("parser");
  if (!parserId) {
    throw new Error("falta --parser (ej. --parser example-38col)");
  }
  const parser = getParser(parserId);
  if (!parser) {
    throw new Error(`no existe un parser con id "${parserId}"`);
  }

  const encoding = (arg("encoding") ?? "latin1") as BufferEncoding;
  const filePath = arg("file");
  const bytes = filePath ? readFileSync(filePath) : await readStdin();
  const rawText = bytes.toString(encoding);

  const result = parser.parse(rawText);
  if (!result) {
    console.log(`El parser "${parserId}" no reconoció el formato (devolvió null).`);
    console.log("\nTexto decodificado que recibió, por si ayuda a ver qué no matcheó:\n");
    console.log(rawText);
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
