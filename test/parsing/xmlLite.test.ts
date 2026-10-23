import { child, children, parseXml, pathTo, textOf, XmlParseError } from "../../src/parsing/xmlLite";

describe("parseXml", () => {
  it("descarta los prefijos de namespace y navega por nombre local", () => {
    const root = parseXml(
      '<?xml version="1.0"?><Invoice xmlns:cbc="urn:x"><cbc:ID>FV1</cbc:ID><cac:Party><cbc:Name>ACME</cbc:Name></cac:Party></Invoice>',
    );
    expect(root.name).toBe("Invoice");
    expect(textOf(child(root, "ID"))).toBe("FV1");
    expect(textOf(pathTo(root, "Party", "Name"))).toBe("ACME");
  });

  it("resuelve entidades con nombre y numéricas", () => {
    const root = parseXml("<a><b>Caf&#xe9; &amp; Pan &#225;</b></a>");
    expect(textOf(child(root, "b"))).toBe("Café & Pan á");
  });

  it("lee atributos, elementos vacíos y varios hijos con el mismo nombre", () => {
    const root = parseXml('<a><n currencyID="COP">1</n><n/><n>3</n><e x=\'1>2\'/></a>');
    expect(children(root, "n")).toHaveLength(3);
    expect(child(root, "n")?.attrs.currencyID).toBe("COP");
    expect(textOf(children(root, "n")[1])).toBeUndefined();
    expect(child(root, "e")?.attrs.x).toBe("1>2");
  });

  it("ignora comentarios y toma el CDATA como texto literal", () => {
    const root = parseXml("<a><!-- nada --><b><![CDATA[1 < 2 & 3]]></b></a>");
    expect(textOf(child(root, "b"))).toBe("1 < 2 & 3");
  });

  it("tolera un BOM al inicio", () => {
    expect(parseXml("﻿<a/>").name).toBe("a");
  });

  it("rechaza un DOCTYPE (sin expansión de entidades)", () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(XmlParseError);
  });

  it.each([
    ["etiquetas cruzadas", "<a><b></a></b>"],
    ["etiqueta sin cerrar", "<a><b>"],
    ["cierre sin apertura", "</a>"],
    ["más de una raíz", "<a/><b/>"],
    ["sin raíz", "   "],
  ])("rechaza XML mal formado: %s", (_label, xml) => {
    expect(() => parseXml(xml)).toThrow(XmlParseError);
  });

  it("rechaza un documento enorme", () => {
    expect(() => parseXml(`<a>${"x".repeat(1_000_001)}</a>`)).toThrow(XmlParseError);
  });
});
