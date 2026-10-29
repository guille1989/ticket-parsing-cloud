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

  describe("datos extra de la venta", () => {
    it("lee el cliente, el tipo de documento y el vencimiento del pago; no copia la dirección", () => {
      const result = parseUblInvoice(fixture("fe-erp-38267.xml"));
      expect(result.kind).toBe("sale");
      if (result.kind !== "sale") return;

      expect(result.ticket).toMatchObject({
        docType: "sale",
        customerName: "CLIENTE DE PRUEBA DOS SAS",
        customerId: "900000002",
        paymentDueDate: "2026-10-22",
      });
      expect(JSON.stringify(result.ticket)).not.toMatch(/CALI/);
      // El fixture no cita una orden de compra: no se inventa.
      expect(result.ticket.purchaseOrder).toBeUndefined();
    });

    it("lee la orden de compra del cliente cuando la factura la cita", () => {
      const xml = fixture("fe-erp-38267.xml").replace(
        "<cbc:DueDate>",
        "<cac:OrderReference><cbc:ID> 4503803859 </cbc:ID></cac:OrderReference><cbc:DueDate>",
      );
      const result = parseUblInvoice(xml);
      if (result.kind !== "sale") throw new Error("se esperaba una venta");
      expect(result.ticket.purchaseOrder).toBe("4503803859");
    });

    it("prefiere el vencimiento de PaymentMeans y cae a cbc:DueDate", () => {
      const withoutMeans = fixture("fe-erp-38267.xml").replace(/<cbc:PaymentDueDate>[^<]*<\/cbc:PaymentDueDate>/, "").replace(
        "<cbc:DueDate>2026-10-22</cbc:DueDate>",
        "<cbc:DueDate>2026-12-10</cbc:DueDate>",
      );
      const fallback = parseUblInvoice(withoutMeans);
      if (fallback.kind !== "sale") throw new Error("se esperaba una venta");
      expect(fallback.ticket.paymentDueDate).toBe("2026-12-10");

      const withMeans = fixture("fe-erp-38267.xml").replace("<cbc:PaymentDueDate>2026-10-22<", "<cbc:PaymentDueDate>2026-11-24<");
      const preferred = parseUblInvoice(withMeans);
      if (preferred.kind !== "sale") throw new Error("se esperaba una venta");
      expect(preferred.ticket.paymentDueDate).toBe("2026-11-24");
    });

    it("ignora un vencimiento que no es una fecha y no lee la fecha de entrega", () => {
      const xml = fixture("fe-erp-38267.xml")
        .replace("<cbc:PaymentDueDate>2026-10-22<", "<cbc:PaymentDueDate>mañana<")
        .replace("<cbc:DueDate>2026-10-22</cbc:DueDate>", "");
      const result = parseUblInvoice(xml);
      if (result.kind !== "sale") throw new Error("se esperaba una venta");
      expect(result.ticket.paymentDueDate).toBeUndefined();
      expect(JSON.stringify(result.ticket)).not.toMatch(/ActualDelivery/i);
    });
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
