import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decodeXmlBytes, parseUblInvoice, readUblIdentity } from "../../src/parsing/ubl";

function fixture(name: string): string {
  return decodeXmlBytes(readFileSync(join(process.cwd(), "fixtures", "ubl", name)));
}

describe("parseUblInvoice", () => {
  it("lee una factura de venta exportada por el ERP (sin firma)", () => {
    const result = parseUblInvoice(fixture("fe-erp-38267.xml"));
    expect(result.kind).toBe("sale");
    if (result.kind !== "sale") return;

    expect(result.ticket.documentNumber).toBe("FVA38267");
    expect(result.ticket.total).toBe(530000);
    // 12:07 en UTC-5 son las 17:07 UTC.
    expect(result.ticket.timestamp).toBe("2026-10-22T17:07:00.000Z");
    expect(result.ticket.items).toEqual([
      { description: "AGUA TRATADA 600 ML BALA SIN GAS", quantity: 10, unitPrice: 35000, subtotal: 350000 },
      { description: "AGUA TRATADA 600 ML BALA CON GAS", quantity: 5, unitPrice: 36000, subtotal: 180000 },
    ]);
    // Facturas de agua tratada: sin IVA ni descuento, no se inventan.
    expect(result.ticket.tax).toBeUndefined();
    expect(result.ticket.discount).toBeUndefined();
  });

  it("lee la copia firmada aunque tenga caracteres de reemplazo y una sola línea", () => {
    const result = parseUblInvoice(fixture("fe-firmada-38266.xml"));
    expect(result.kind).toBe("sale");
    if (result.kind !== "sale") return;

    expect(result.ticket.documentNumber).toBe("FVA38266");
    expect(result.ticket.total).toBe(364000);
    expect(result.ticket.timestamp).toBe("2026-10-22T17:00:00.000Z");
    expect(result.ticket.items.map((i) => [i.quantity, i.unitPrice, i.subtotal])).toEqual([
      [6, 36000, 216000],
      [4, 37000, 148000],
    ]);
  });

  it("la copia firmada y la del ERP de la misma factura dan la misma venta", () => {
    const erp = parseUblInvoice(fixture("fe-erp-38267.xml"));
    const signed = parseUblInvoice(fixture("fe-firmada-38267.xml"));
    expect(signed).toEqual(erp);
  });

  it("no cuenta un documento soporte (una compra) como venta", () => {
    const result = parseUblInvoice(fixture("documento-soporte-DECS1.xml"));
    expect(result.kind).toBe("not-sale");
    if (result.kind === "not-sale") expect(result.reason).toMatch(/documento soporte/);
  });

  it("no cuenta una nota crédito como venta", () => {
    const result = parseUblInvoice('<CreditNote xmlns="urn:x"><ID>NC1</ID></CreditNote>');
    expect(result).toMatchObject({ kind: "not-sale" });
  });

  it("rechaza una factura cuyas líneas no suman lo que declara", () => {
    const xml = fixture("fe-erp-38267.xml").replace(
      /(<cbc:LineExtensionAmount currencyID="COP">)530000\.00/,
      "$1999999.00",
    );
    const result = parseUblInvoice(xml);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toMatch(/líneas suman/);
  });

  it("rechaza una factura cuyo total a pagar no cierra", () => {
    const xml = fixture("fe-erp-38267.xml").replace(
      /(<cbc:PayableAmount currencyID="COP">)530000\.00/,
      "$1123.00",
    );
    const result = parseUblInvoice(xml);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toMatch(/no cierra/);
  });

  it("suma el IVA del documento una sola vez y lo reporta aparte", () => {
    const xml = fixture("fe-erp-38267.xml").replace(
      "<cac:LegalMonetaryTotal>",
      '<cac:TaxTotal><cbc:TaxAmount currencyID="COP">100700.00</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal>',
    ).replace(
      /(<cbc:PayableAmount currencyID="COP">)530000\.00/,
      "$1630700.00",
    );
    const result = parseUblInvoice(xml);
    expect(result.kind).toBe("sale");
    if (result.kind !== "sale") return;
    expect(result.ticket.tax).toBe(100700);
    expect(result.ticket.total).toBe(630700);
  });

  it("deriva el precio unitario del importe cuando el precio declarado no lo reproduce", () => {
    const xml = fixture("fe-erp-38267.xml")
      .replace(/<cbc:PriceAmount currencyID="COP">35000\.00/, '<cbc:PriceAmount currencyID="COP">7.00');
    const result = parseUblInvoice(xml);
    expect(result.kind).toBe("sale");
    if (result.kind === "sale") expect(result.ticket.items[0].unitPrice).toBe(35000);
  });

  it("reporta XML mal formado como inválido, sin lanzar", () => {
    expect(parseUblInvoice("<Invoice><ID>")).toMatchObject({ kind: "invalid" });
  });
});

describe("readUblIdentity", () => {
  it("devuelve número y emisor, iguales en la copia del ERP y en la firmada", () => {
    const erp = readUblIdentity(fixture("fe-erp-38267.xml"));
    const signed = readUblIdentity(fixture("fe-firmada-38267.xml"));
    expect(erp).toEqual({ documentNumber: "FVA38267", issuerId: "900528724", typeCode: "01" });
    expect(signed).toEqual(erp);
  });

  it("en un documento soporte el emisor es el proveedor, no el negocio", () => {
    expect(readUblIdentity(fixture("documento-soporte-DECS1.xml"))).toEqual({
      documentNumber: "DECS1",
      issuerId: "10000001",
      typeCode: "05",
    });
  });

  it("informa un error si faltan datos", () => {
    expect(readUblIdentity("<Invoice/>")).toHaveProperty("error");
  });
});

describe("decodeXmlBytes", () => {
  it("decodifica UTF-8 válido", () => {
    expect(decodeXmlBytes(Buffer.from("<a>Dirección</a>", "utf-8"))).toBe("<a>Dirección</a>");
  });

  it("cae a Windows-1252 si los bytes no son UTF-8 válido", () => {
    expect(decodeXmlBytes(Buffer.from([0x3c, 0x61, 0x3e, 0xf3, 0x3c, 0x2f, 0x61, 0x3e]))).toBe("<a>ó</a>");
  });
});
