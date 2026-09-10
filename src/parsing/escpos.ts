import { deflateSync } from "node:zlib";

/**
 * Lector de un stream ESC/POS crudo (lo que la captura de spool sube como
 * `rawKind: "escpos"`). Un mismo ticket puede venir como texto, como una
 * imagen raster, o una mezcla — varios POS (Loggro entre ellos) renderizan
 * la factura entera a un bitmap y la mandan con comandos de gráficos.
 *
 * Hace UNA pasada por el stream y devuelve las tres cosas que el parser
 * necesita para decidir el camino:
 *  - `text`: los bytes literales, ya sin comandos (para el parser de texto)
 *  - `bands`: las franjas de imagen raster encontradas, en orden
 *  - `rasterBytes` / `looksRasterDominant`: para elegir texto vs OCR
 *
 * NO intenta ser un emulador ESC/POS completo. Para los comandos que no son
 * de gráficos, con saber cuántos bytes ocupan alcanza (un largo equivocado
 * solo mete unos pocos caracteres de ruido en `text`, tolerable). Los
 * comandos de raster (`GS 8 L`, `GS v 0`, `ESC *`) sí se parsean con
 * precisión.
 */

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;

export interface RasterBand {
  widthDots: number;
  heightDots: number;
  /** 1 bit por pixel, fila mayor: `pixels[y * rowBytes + (x >> 3)]`, MSB primero. 1 = negro. */
  data: Buffer;
  rowBytes: number;
}

export interface EscposContent {
  text: string;
  bands: RasterBand[];
  rasterBytes: number;
}

/** Cuántos bytes ocupa un comando ESC/POS que NO es de gráficos. -1 = "no es un comando que reconozca / no tiene param". */
function nonGraphicCommandLength(buf: Buffer, i: number): number {
  const b = buf[i];

  if (b === ESC) {
    const c = buf[i + 1];
    switch (c) {
      case 0x40: // ESC @  init
      case 0x32: // ESC 2  default line spacing
      case 0x69: // ESC i  full cut
      case 0x6d: // ESC m  partial cut
        return 2;
      case 0x21: // ESC !  print mode
      case 0x2d: // ESC -  underline
      case 0x33: // ESC 3  line spacing n
      case 0x41: // ESC A  (page mode)
      case 0x42: // ESC B  (panel buttons)
      case 0x4a: // ESC J  print & feed n
      case 0x4b: // ESC K  print & reverse feed n
      case 0x64: // ESC d  print & feed n lines
      case 0x65: // ESC e  print & reverse feed n lines
      case 0x45: // ESC E  emphasize
      case 0x47: // ESC G  double strike
      case 0x4d: // ESC M  font
      case 0x52: // ESC R  international char set
      case 0x74: // ESC t  code table
      case 0x61: // ESC a  justification
      case 0x7b: // ESC {  upside-down
      case 0x20: // ESC SP right-side spacing
      case 0x72: // ESC r  print color
      case 0x63: // ESC c ...  (c3/c4/c5 select) — consume the selector + value
        return 3;
      case 0x3d: // ESC = n  select peripheral
        return 3;
      case 0x24: // ESC $ nL nH  absolute position
      case 0x5c: // ESC \ nL nH  relative position
        return 4;
      case 0x70: // ESC p m t1 t2  pulse
        return 5;
      case 0x53: // ESC S
        return 2;
      case 0x54: // ESC T  print direction (page mode)
        return 3;
      case 0x57: // ESC W  print area (page mode)
        return 11;
      default:
        return 2; // comando ESC desconocido — asumir sin parámetros
    }
  }

  if (b === GS) {
    const c = buf[i + 1];
    switch (c) {
      case 0x21: // GS !  char size
      case 0x42: // GS B  reverse
      case 0x48: // GS H  HRI position
      case 0x66: // GS f  HRI font
      case 0x77: // GS w  barcode width
      case 0x68: // GS h  barcode height
      case 0x61: // GS a  ASB
      case 0x72: // GS r  status transmit
      case 0x49: // GS I  printer info
      case 0x45: // GS E  (real-time / dot density on some)
      case 0x54: // GS T  (position on some)
      case 0x62: // GS b  smoothing
      case 0x7a: // GS z  (misc)
        return 3;
      case 0x3a: // GS :  start/end macro
        return 2;
      case 0x2f: // GS /  print downloaded bit image
        return 3;
      case 0x50: // GS P x y  set unit
        return 3;
      case 0x4c: // GS L nL nH  left margin
      case 0x57: // GS W nL nH  print area width
        return 5;
      case 0x56: {
        // GS V m  |  GS V m n  (m = 65/66 lleva n)
        const m = buf[i + 2];
        return m === 0x41 || m === 0x42 ? 4 : 3;
      }
      default:
        return 2; // GS desconocido — se maneja el resto (( , 8 , v , * ) aparte
    }
  }

  if (b === FS) {
    const c = buf[i + 1];
    switch (c) {
      case 0x21: // FS !  print mode (kanji)
      case 0x2d: // FS -  underline (kanji)
      case 0x43: // FS C  kanji code system
      case 0x53: // FS S  kanji spacing (2 params → 3)
        return 3;
      case 0x2e: // FS .  cancel kanji
      case 0x26: // FS &  select kanji
        return 2;
      case 0x70: // FS p n m  print NV bit image
        return 4;
      default:
        return 2;
    }
  }

  return -1;
}

function pushBand(bands: RasterBand[], widthDots: number, heightDots: number, data: Buffer): void {
  if (widthDots <= 0 || heightDots <= 0 || data.length === 0) return;
  bands.push({ widthDots, heightDots, data, rowBytes: Math.ceil(widthDots / 8) });
}

/** `ESC *` es formato COLUMNA (cada byte = 8 dots verticales) — se transpone a formato fila. */
function bandFromEscStar(mode: number, columns: number, colData: Buffer): RasterBand | null {
  const heightDots = mode === 0 || mode === 1 ? 8 : 24;
  const bytesPerCol = heightDots / 8;
  const rowBytes = Math.ceil(columns / 8);
  const out = Buffer.alloc(rowBytes * heightDots, 0);
  for (let x = 0; x < columns; x++) {
    for (let k = 0; k < bytesPerCol; k++) {
      const byte = colData[x * bytesPerCol + k] ?? 0;
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (0x80 >> bit)) {
          const y = k * 8 + bit;
          out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
  }
  return { widthDots: columns, heightDots, data: out, rowBytes };
}

export function readEscpos(buf: Buffer): EscposContent {
  const bands: RasterBand[] = [];
  let rasterBytes = 0;
  const textParts: string[] = [];
  let i = 0;

  while (i < buf.length) {
    const b = buf[i];

    // --- comandos de gráficos (parseo preciso) ---
    if (b === GS && buf[i + 1] === 0x38 && buf[i + 2] === 0x4c) {
      // GS 8 L p1 p2 p3 p4 m fn [params]   (imágenes grandes)
      const value = buf[i + 3] + buf[i + 4] * 256 + buf[i + 5] * 65536 + buf[i + 6] * 16777216;
      const fn = buf[i + 8];
      if (fn === 112) {
        // 112: guardar raster. a bx by c xL xH yL yH d1..dk
        const xL = buf[i + 13], xH = buf[i + 14], yL = buf[i + 15], yH = buf[i + 16];
        const widthDots = xL + xH * 256;
        const heightDots = yL + yH * 256;
        const rowBytes = Math.ceil(widthDots / 8);
        const dataStart = i + 17;
        const dataLen = rowBytes * heightDots;
        pushBand(bands, widthDots, heightDots, buf.subarray(dataStart, dataStart + dataLen));
        rasterBytes += dataLen;
      }
      i += 7 + Math.max(value, 2);
      continue;
    }

    if (b === GS && buf[i + 1] === 0x28) {
      // GS ( X pL pH m fn [params]   (X en i+2, pL/pH en i+3/i+4, m en i+5, fn en i+6)
      const paramLen = buf[i + 3] + buf[i + 4] * 256;
      const marker = buf[i + 2]; // X: 'L' gráficos, 'k' código de barras/QR, etc.
      const fn = buf[i + 6];
      if (marker === 0x4c && fn === 112) {
        // GS ( L, fn 112: a bx by c xL xH yL yH d1..dk  (arrancan tras m y fn)
        const xL = buf[i + 11], xH = buf[i + 12], yL = buf[i + 13], yH = buf[i + 14];
        const widthDots = xL + xH * 256;
        const heightDots = yL + yH * 256;
        const rowBytes = Math.ceil(widthDots / 8);
        const dataStart = i + 15;
        const dataLen = rowBytes * heightDots;
        pushBand(bands, widthDots, heightDots, buf.subarray(dataStart, dataStart + dataLen));
        rasterBytes += dataLen;
      }
      i += 5 + paramLen;
      continue;
    }

    if (b === GS && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      // GS v 0 m xL xH yL yH [data]   (raster obsoleto pero muy usado)
      const xL = buf[i + 4], xH = buf[i + 5], yL = buf[i + 6], yH = buf[i + 7];
      const rowBytes = xL + xH * 256;
      const heightDots = yL + yH * 256;
      const dataStart = i + 8;
      const dataLen = rowBytes * heightDots;
      pushBand(bands, rowBytes * 8, heightDots, buf.subarray(dataStart, dataStart + dataLen));
      rasterBytes += dataLen;
      i += 8 + dataLen;
      continue;
    }

    if (b === ESC && buf[i + 1] === 0x2a) {
      // ESC * m nL nH [data]   (bit image, formato columna)
      const mode = buf[i + 2];
      const columns = buf[i + 3] + buf[i + 4] * 256;
      const bytesPerCol = mode === 0 || mode === 1 ? 1 : 3;
      const dataStart = i + 5;
      const dataLen = columns * bytesPerCol;
      const band = bandFromEscStar(mode, columns, buf.subarray(dataStart, dataStart + dataLen));
      if (band) {
        bands.push(band);
        rasterBytes += dataLen;
      }
      i += 5 + dataLen;
      continue;
    }

    if (b === GS && buf[i + 1] === 0x2a) {
      // GS * x y [data x*y*8]   (definir imagen descargada — no se rasteriza acá, solo se saltea)
      const x = buf[i + 2], y = buf[i + 3];
      const dataLen = x * y * 8;
      rasterBytes += dataLen;
      i += 4 + dataLen;
      continue;
    }

    // --- otros comandos: saltear por largo ---
    const cmdLen = nonGraphicCommandLength(buf, i);
    if (cmdLen > 0) {
      i += cmdLen;
      continue;
    }

    // --- byte literal ---
    if (b === 0x0a) {
      textParts.push("\n");
    } else if (b === 0x09) {
      textParts.push(" ");
    } else if (b >= 0x20 && b !== 0x7f) {
      // 0x80–0xFF: se deja tal cual (latin1). El code page real lo elige
      // `ESC t n` y todavía no se decodifica — refinamiento posterior, igual
      // que en `portCapture.ts`. Alcanza para el parser de texto y para
      // decidir texto-vs-imagen.
      textParts.push(String.fromCharCode(b));
    }
    i += 1;
  }

  return { text: cleanText(textParts.join("")), bands, rasterBytes };
}

function cleanText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/gu;

/**
 * `true` si el ticket es básicamente una imagen: hay raster y casi nada de
 * texto literal. Un ticket de texto real tiene cientos de letras/números;
 * uno raster (Loggro) tiene ~0.
 */
export function looksRasterDominant(content: EscposContent): boolean {
  if (content.rasterBytes < 512 || content.bands.length === 0) return false;
  const wordChars = (content.text.match(WORD_CHAR_RE) ?? []).length;
  return wordChars < 40;
}

// --- PNG (1 pasada, sin dependencias más allá de zlib) ---

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * Apila las franjas raster verticalmente (alineadas a la izquierda, fondo
 * blanco) y devuelve un PNG en escala de grises de 8 bits. `null` si no hay
 * ninguna franja. Un bit en 1 (negro en ESC/POS) → pixel 0x00.
 */
/** Margen blanco a cada lado del lienzo — protege el texto que Loggro dibuja pegado al borde y ayuda al OCR. */
const MARGIN = 8;

export function rasterToPng(bands: RasterBand[]): Buffer | null {
  if (bands.length === 0) return null;

  const contentWidth = Math.max(...bands.map((band) => band.widthDots));
  const width = contentWidth + MARGIN * 2;
  const height = bands.reduce((sum, band) => sum + band.heightDots, 0);
  if (contentWidth <= 0 || height <= 0) return null;

  // Filtro 0 (None) por fila: 1 byte de filtro + `width` bytes de gris.
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;

  let yOffset = 0;
  for (const band of bands) {
    for (let y = 0; y < band.heightDots; y++) {
      const rowStart = (yOffset + y) * (width + 1) + 1 + MARGIN;
      for (let x = 0; x < band.widthDots; x++) {
        const bit = (band.data[y * band.rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (bit) raw[rowStart + x] = 0x00;
      }
    }
    yOffset += band.heightDots;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface RasterImage {
  png: Buffer;
  width: number;
  height: number;
}

/** Reconstruye el ticket-imagen a PNG. `null` si el stream no traía raster. */
export function extractRasterPng(buf: Buffer): RasterImage | null {
  const { bands } = readEscpos(buf);
  const png = rasterToPng(bands);
  if (!png) return null;
  return {
    png,
    width: Math.max(...bands.map((b) => b.widthDots)) + MARGIN * 2,
    height: bands.reduce((sum, b) => sum + b.heightDots, 0),
  };
}

/** El texto literal del stream, ya sin comandos. Vacío si el ticket es solo imagen. */
export function extractPlainText(buf: Buffer): string {
  return readEscpos(buf).text;
}

/**
 * Reconstruye el ticket-imagen partido en **franjas verticales** de a lo
 * sumo `maxTileHeight` px de alto, en orden. Un ticket térmico llega a
 * medir varios miles de dots; mandarlo entero a Bedrock hace que el modelo
 * lo reduzca de escala y pierda el texto chico. Cada franja se manda como
 * una imagen aparte en el mismo mensaje.
 */
export function extractRasterTiles(buf: Buffer, maxTileHeight = 1400): RasterImage[] {
  const { bands } = readEscpos(buf);
  if (bands.length === 0) return [];

  const tiles: RasterImage[] = [];
  let group: RasterBand[] = [];
  let groupHeight = 0;

  const flush = (): void => {
    if (group.length === 0) return;
    const png = rasterToPng(group);
    if (png) {
      tiles.push({
        png,
        width: Math.max(...group.map((b) => b.widthDots)) + MARGIN * 2,
        height: group.reduce((sum, b) => sum + b.heightDots, 0),
      });
    }
    group = [];
    groupHeight = 0;
  };

  for (const band of bands) {
    if (groupHeight > 0 && groupHeight + band.heightDots > maxTileHeight) flush();
    group.push(band);
    groupHeight += band.heightDots;
  }
  flush();
  return tiles;
}
