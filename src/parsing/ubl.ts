import { child, children, parseXml, pathTo, textOf, XmlNode, XmlParseError } from "./xmlLite.js";
import type { ParsedItem, ParsedTicket } from "./types.js";

/**
 * Facturas electrónicas de la DIAN (UBL 2.1) como fuente de ventas — el
 * camino de los negocios cuyo ERP deja el XML de cada factura en una carpeta
 * (caso Alamo, UNO/Siesa) en vez de imprimir un ticket. Es determinístico: no
 * pasa por OCR ni por Bedrock, así que un XML de venta bien formado llega
 * directo a `parsed`.
 */

/**
 * `InvoiceTypeCode` de los documentos que son una venta: 01 factura de venta,
 * 02 exportación, 03 contingencia, 04 contingencia DIAN. El 05 es
 * "documento soporte" (una COMPRA a un no obligado a facturar, donde el
 * negocio figura como cliente) y no debe contarse como ingreso.
 */
export const SALE_TYPE_CODES: ReadonlySet<string> = new Set(["01", "02", "03", "04"]);

/** Los XML de factura salen en UTC-5 (Colombia) cuando no traen hora. */
const DEFAULT_OFFSET = "-05:00";
const TOLERANCE_ABS = 1;

export type UblResult =
  | { kind: "sale"; ticket: ParsedTicket }
  | { kind: "not-sale"; reason: string }
  | { kind: "invalid"; reason: string };

export interface UblIdentity {
  /** `cbc:ID` — el número de la factura (ej. "FVA38267"). */
  documentNumber: string;
  /** NIT de quien emite; junto con el número identifica el documento de forma única. */
  issuerId: string;
  typeCode: string | undefined;
}

/**
 * Los bytes de un XML pueden venir en UTF-8 válido o, según la herramienta
 * que lo exportó, en Windows-1252 aunque declaren UTF-8. Se intenta estricto y
 * se cae a Windows-1252 antes que perder todos los acentos.
 */
export function decodeXmlBytes(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function parseDocument(xml: string): XmlNode | { error: string } {
  try {
    return parseXml(xml);
  } catch (err) {
    if (err instanceof XmlParseError) return { error: err.message };
    throw err;
  }
}

function isError(value: XmlNode | { error: string }): value is { error: string } {
  return "error" in value;
}

function amount(node: XmlNode | undefined): number | undefined {
  const raw = textOf(node);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function partyId(party: XmlNode | undefined): string | undefined {
  return (
    textOf(pathTo(party, "Party", "PartyTaxScheme", "CompanyID")) ??
    textOf(pathTo(party, "Party", "PartyLegalEntity", "CompanyID"))
  );
}

/** Número de documento y emisor, sin interpretar montos — lo usa `ingest` para no registrar dos veces una misma factura. */
export function readUblIdentity(xml: string): UblIdentity | { error: string } {
  const root = parseDocument(xml);
  if (isError(root)) return root;
  const documentNumber = textOf(child(root, "ID"));
  const issuerId = partyId(child(root, "AccountingSupplierParty"));
  if (!documentNumber) return { error: "el XML no trae el número de documento (cbc:ID)" };
  if (!issuerId) return { error: "el XML no trae el NIT del emisor" };
  return { documentNumber, issuerId, typeCode: textOf(child(root, "InvoiceTypeCode")) };
}

function toIsoTimestamp(issueDate: string, issueTime: string | undefined): string | undefined {
  const time = issueTime ?? `00:00:00${DEFAULT_OFFSET}`;
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(time);
  const parsed = new Date(`${issueDate}T${time}${hasOffset ? "" : DEFAULT_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseLine(line: XmlNode): ParsedItem | { error: string } {
  const description = textOf(pathTo(line, "Item", "Description")) ?? textOf(pathTo(line, "Item", "Name"));
  const quantity = amount(child(line, "InvoicedQuantity"));
  const subtotal = amount(child(line, "LineExtensionAmount"));
  if (!description) return { error: "una línea de la factura no tiene descripción" };
  if (quantity === undefined || quantity <= 0) return { error: `cantidad inválida en "${description}"` };
  if (subtotal === undefined || subtotal < 0) return { error: `importe inválido en "${description}"` };

  // El ERP de Alamo declara `PriceAmount` por la cantidad completa de la línea
  // junto con un `BaseQuantity` igual a la cantidad, así que el precio
  // unitario "por la norma" (precio / base) no cierra con el importe. Se
  // prefiere el precio declarado cuando reproduce el importe y, si no, se
  // deriva del propio importe — que es lo que se cobra.
  const price = amount(pathTo(line, "Price", "PriceAmount"));
  const unitPrice = price !== undefined && Math.abs(price * quantity - subtotal) <= TOLERANCE_ABS ? price : round2(subtotal / quantity);
  return { description, quantity, unitPrice, subtotal };
}

export function parseUblInvoice(xml: string): UblResult {
  const root = parseDocument(xml);
  if (isError(root)) return { kind: "invalid", reason: `XML inválido: ${root.error}` };

  if (root.name === "CreditNote") {
    return { kind: "not-sale", reason: "el documento es una nota crédito (aún no se restan de las ventas)" };
  }
  if (root.name === "DebitNote") {
    return { kind: "not-sale", reason: "el documento es una nota débito (aún no se suman a las ventas)" };
  }
  if (root.name !== "Invoice") {
    return { kind: "not-sale", reason: `el XML no es una factura (elemento raíz <${root.name}>)` };
  }

  const typeCode = textOf(child(root, "InvoiceTypeCode"));
  if (typeCode === "05") {
    return { kind: "not-sale", reason: "el documento es un documento soporte (una compra del negocio), no una venta" };
  }
  if (!typeCode || !SALE_TYPE_CODES.has(typeCode)) {
    return { kind: "not-sale", reason: `tipo de documento no soportado como venta (InvoiceTypeCode ${typeCode ?? "ausente"})` };
  }

  const documentNumber = textOf(child(root, "ID"));
  const issueDate = textOf(child(root, "IssueDate"));
  if (!documentNumber) return { kind: "invalid", reason: "la factura no trae número (cbc:ID)" };
  if (!issueDate) return { kind: "invalid", reason: "la factura no trae fecha de emisión" };
  const timestamp = toIsoTimestamp(issueDate, textOf(child(root, "IssueTime")));
  if (!timestamp) return { kind: "invalid", reason: `fecha de emisión inválida (${issueDate})` };

  const items: ParsedItem[] = [];
  for (const line of children(root, "InvoiceLine")) {
    const item = parseLine(line);
    if ("error" in item) return { kind: "invalid", reason: item.error };
    items.push(item);
  }
  if (items.length === 0) return { kind: "invalid", reason: "la factura no tiene líneas" };

  const totals = child(root, "LegalMonetaryTotal");
  const lineExtension = amount(child(totals, "LineExtensionAmount"));
  const payable = amount(child(totals, "PayableAmount"));
  if (lineExtension === undefined || payable === undefined) {
    return { kind: "invalid", reason: "la factura no trae LegalMonetaryTotal (importe de líneas / total a pagar)" };
  }
  const discount = amount(child(totals, "AllowanceTotalAmount")) ?? 0;
  const charge = amount(child(totals, "ChargeTotalAmount")) ?? 0;
  const prepaid = amount(child(totals, "PrepaidAmount")) ?? 0;

  // Solo los `TaxTotal` del documento: los de cada línea repiten el mismo
  // impuesto y sumarlos lo contaría dos veces. Estas facturas de agua tratada
  // no traen ninguno (IVA excluido), y eso es un 0, no un error.
  const tax = children(root, "TaxTotal").reduce((sum, node) => sum + (amount(child(node, "TaxAmount")) ?? 0), 0);

  const itemsSum = items.reduce((sum, item) => sum + item.subtotal, 0);
  if (Math.abs(itemsSum - lineExtension) > TOLERANCE_ABS) {
    return { kind: "invalid", reason: `las líneas suman ${itemsSum} pero la factura declara ${lineExtension}` };
  }
  const expectedPayable = lineExtension - discount + charge + tax - prepaid;
  if (Math.abs(payable - expectedPayable) > TOLERANCE_ABS) {
    return {
      kind: "invalid",
      reason: `el total a pagar (${payable}) no cierra con líneas − descuento + cargos + impuesto − anticipos (${expectedPayable})`,
    };
  }
  if (charge !== 0) {
    // No hay dónde registrar un cargo sin que los números dejen de cerrar contra los ítems.
    return { kind: "invalid", reason: `la factura trae cargos (${charge}) que todavía no se interpretan` };
  }

  const ticket: ParsedTicket = {
    items,
    // La venta es lo facturado, antes de descontar anticipos ya cobrados.
    total: round2(payable + prepaid),
    timestamp,
    documentNumber,
  };
  if (discount > 0) ticket.discount = discount;
  if (tax > 0) ticket.tax = tax;
  return { kind: "sale", ticket };
}
