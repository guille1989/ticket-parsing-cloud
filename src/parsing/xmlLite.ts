/**
 * Lector XML mínimo, sin dependencias, para los documentos UBL 2.1 de la
 * DIAN (facturas electrónicas). No es un parser XML general: no resuelve
 * entidades definidas por el documento ni DTDs (un `<!DOCTYPE` se rechaza, así
 * no hay forma de que un archivo malicioso expanda entidades), no valida
 * contra un esquema y descarta los prefijos de namespace — en UBL
 * `cbc:ID` y `cac:ID` nunca conviven con otro significado a la misma altura,
 * así que se navega por nombre local.
 */

export interface XmlNode {
  /** Nombre local, sin prefijo de namespace. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Texto directo del nodo (sin el de los hijos), con las entidades ya resueltas. */
  text: string;
}

export class XmlParseError extends Error {}

/** Un XML de factura real ronda los 10-20 KB; por encima de esto no es una factura. */
const MAX_XML_CHARS = 1_000_000;
const MAX_DEPTH = 64;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x")) return safeFromCodePoint(parseInt(body.slice(2), 16), match);
    if (body.startsWith("#")) return safeFromCodePoint(parseInt(body.slice(1), 10), match);
    return NAMED_ENTITIES[body] ?? match;
  });
}

function safeFromCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(source)) !== null) {
    attrs[localName(match[1])] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

export function parseXml(input: string): XmlNode {
  if (input.length > MAX_XML_CHARS) throw new XmlParseError("el XML es demasiado grande");
  const xml = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let pos = 0;

  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    const current = stack[stack.length - 1];
    if (lt === -1) {
      current.text += decodeEntities(xml.slice(pos));
      break;
    }
    if (lt > pos) current.text += decodeEntities(xml.slice(pos, lt));

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlParseError("comentario sin cerrar");
      pos = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlParseError("CDATA sin cerrar");
      current.text += xml.slice(lt + 9, end);
      pos = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlParseError("instrucción de procesamiento sin cerrar");
      pos = end + 2;
    } else if (xml.startsWith("<!", lt)) {
      throw new XmlParseError("no se admiten DOCTYPE ni declaraciones de entidades");
    } else if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) throw new XmlParseError("etiqueta de cierre sin terminar");
      const name = localName(xml.slice(lt + 2, end).trim());
      if (stack.length === 1 || current.name !== name) {
        throw new XmlParseError(`etiqueta de cierre inesperada </${name}>`);
      }
      stack.pop();
      pos = end + 1;
    } else {
      const end = findTagEnd(xml, lt + 1);
      if (end === -1) throw new XmlParseError("etiqueta de apertura sin terminar");
      const inner = xml.slice(lt + 1, end);
      const selfClosing = inner.endsWith("/");
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameMatch = /^\s*([^\s/>]+)/.exec(body);
      if (!nameMatch) throw new XmlParseError("etiqueta sin nombre");
      const node: XmlNode = {
        name: localName(nameMatch[1]),
        attrs: parseAttributes(body.slice(nameMatch[0].length)),
        children: [],
        text: "",
      };
      current.children.push(node);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) throw new XmlParseError("el XML está anidado a demasiada profundidad");
        stack.push(node);
      }
      pos = end + 1;
    }
  }

  if (stack.length !== 1) throw new XmlParseError(`etiqueta <${stack[stack.length - 1].name}> sin cerrar`);
  const documentRoot = root.children[0];
  if (!documentRoot || root.children.length !== 1) throw new XmlParseError("se esperaba exactamente un elemento raíz");
  return documentRoot;
}

/** Posición del `>` que cierra una etiqueta, ignorando los que aparecen dentro de valores de atributo. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/** Primer hijo directo con ese nombre local. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((c) => c.name === name) ?? [];
}

/** Sigue una ruta de nombres locales hijo a hijo. */
export function pathTo(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  let current = node;
  for (const name of names) {
    current = child(current, name);
    if (!current) return undefined;
  }
  return current;
}

/** Texto recortado de un nodo, o `undefined` si falta o está vacío. */
export function textOf(node: XmlNode | undefined): string | undefined {
  const text = node?.text.trim();
  return text ? text : undefined;
}
