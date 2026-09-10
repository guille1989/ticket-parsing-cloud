import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { extractPlainText, extractRasterPng, looksRasterDominant, rasterToPng, readEscpos } from "../../src/parsing/escpos";
import type { RasterBand } from "../../src/parsing/escpos";

/** Captura real: factura de Loggro que el POS imprime como imagen raster. */
const LOGGRO_RASTER = readFileSync(join(process.cwd(), "fixtures", "escpos", "loggro-factura-raster.escpos"));

/** Arma un stream ESC/POS de texto plano (init + líneas + corte). */
function textStream(lines: string): Buffer {
  return Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from(lines, "latin1"), Buffer.from([0x1d, 0x56, 0x00])]);
}

/** `GS v 0` con una franja raster de `widthBytes*8` × `height` toda en negro. */
function rasterStream(widthBytes: number, height: number): Buffer {
  const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, height & 0xff, height >> 8]);
  return Buffer.concat([Buffer.from([0x1b, 0x40]), header, Buffer.alloc(widthBytes * height, 0xff), Buffer.from([0x1d, 0x56, 0x00])]);
}

describe("readEscpos — texto", () => {
  test("extrae el texto literal y descarta los comandos", () => {
    const buf = Buffer.concat([
      Buffer.from([0x1b, 0x40]), // ESC @
      Buffer.from([0x1b, 0x61, 0x01]), // ESC a 1 (centrar)
      Buffer.from("EMPANADAS TIPICAS\n", "latin1"),
      Buffer.from([0x1d, 0x21, 0x11]), // GS ! (tamaño)
      Buffer.from("TOTAL $6.000\n", "latin1"),
      Buffer.from([0x1b, 0x64, 0x03]), // ESC d 3 (avance)
      Buffer.from([0x1d, 0x56, 0x00]), // GS V 0 (corte)
    ]);
    const { text, bands, rasterBytes } = readEscpos(buf);
    expect(text).toBe("EMPANADAS TIPICAS\nTOTAL $6.000");
    expect(bands).toHaveLength(0);
    expect(rasterBytes).toBe(0);
  });

  test("un ticket de texto no es raster-dominante", () => {
    const content = readEscpos(textStream("Cafe con leche  4.500\nMedialuna       1.200\nTOTAL           5.700\n"));
    expect(looksRasterDominant(content)).toBe(false);
    expect(extractRasterPng(textStream("hola mundo"))).toBeNull();
  });

  test("no confunde los bytes de una franja raster con texto", () => {
    const content = readEscpos(rasterStream(72, 100));
    expect(content.text).toBe("");
    expect(content.bands).toHaveLength(1);
    expect(content.bands[0].widthDots).toBe(576);
    expect(content.bands[0].heightDots).toBe(100);
  });
});

describe("readEscpos — captura real de Loggro (imagen raster)", () => {
  const content = readEscpos(LOGGRO_RASTER);

  test("encuentra las 10 franjas raster que componen la factura", () => {
    expect(content.bands).toHaveLength(10);
    expect(content.bands.every((b) => b.widthDots > 0 && b.heightDots > 0)).toBe(true);
    // El .SPL es casi todo bitmap: ~175 KB, y el texto literal es nulo.
    expect(content.rasterBytes).toBeGreaterThan(150_000);
    expect((content.text.match(/[\p{L}\p{N}]/gu) ?? []).length).toBeLessThan(40);
  });

  test("looksRasterDominant = true", () => {
    expect(looksRasterDominant(content)).toBe(true);
  });

  test("extractPlainText queda prácticamente vacío (no hay texto que parsear)", () => {
    expect(extractPlainText(LOGGRO_RASTER).trim().length).toBeLessThan(40);
  });

  test("extractRasterPng reconstruye un PNG válido de ~576 de ancho y varios miles de alto", () => {
    const image = extractRasterPng(LOGGRO_RASTER);
    expect(image).not.toBeNull();
    if (!image) return;

    // firma PNG
    expect(image.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    // IHDR: ancho/alto declarados coinciden con lo reportado
    expect(image.png.readUInt32BE(16)).toBe(image.width);
    expect(image.png.readUInt32BE(20)).toBe(image.height);
    expect(image.width).toBeGreaterThanOrEqual(576);
    expect(image.width).toBeLessThan(700);
    expect(image.height).toBeGreaterThan(2000);

    // el IDAT infla al tamaño esperado (filtro None: (w+1)*h) y tiene tinta
    const idatLen = image.png.readUInt32BE(33);
    const idat = image.png.subarray(41, 41 + idatLen);
    const rawPixels = inflateSync(idat);
    expect(rawPixels.length).toBe((image.width + 1) * image.height);
    expect(rawPixels.includes(0x00)).toBe(true); // hay pixeles negros (el ticket no salió en blanco)
  });
});

describe("rasterToPng", () => {
  test("apila franjas de distinto ancho sin romperse (pad a la más ancha + margen)", () => {
    const bands: RasterBand[] = [
      { widthDots: 200, heightDots: 10, rowBytes: 25, data: Buffer.alloc(250, 0xff) },
      { widthDots: 576, heightDots: 20, rowBytes: 72, data: Buffer.alloc(1440, 0x00) },
    ];
    const png = rasterToPng(bands);
    expect(png).not.toBeNull();
    expect(png!.readUInt32BE(16)).toBe(576 + 16); // ancho = más ancha + 2*margen
    expect(png!.readUInt32BE(20)).toBe(30); // alto = suma
  });

  test("sin franjas devuelve null", () => {
    expect(rasterToPng([])).toBeNull();
  });
});
