export interface ParsedItem {
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  voided?: boolean;
}

export interface ParsedTicket {
  items: ParsedItem[];
  discount?: number;
  tip?: number;
  /**
   * Impuesto (IVA) total del ticket, si figura desglosado. En las facturas
   * colombianas los ítems suelen mostrarse a precio base (sin IVA) y el
   * "VALOR A PAGAR" ya lo incluye — `tax` cierra esa diferencia para el
   * chequeo de coherencia. Ausente = el ticket no desglosa impuesto (o los
   * ítems ya vienen con IVA incluido).
   */
  tax?: number;
  /**
   * Base gravable total de la sección de impuestos, tal como está impresa
   * (columna "Base"). No se persiste: sirve solo para verificar lo leído —
   * en una factura colombiana Base + Impuesto es la parte gravada del VALOR
   * A PAGAR (todo, salvo productos exentos), y es un número independiente de
   * los ítems y del total (ver `taxSection.ts`).
   */
  taxBase?: number;
  total: number;
  timestamp: string; // ISO 8601
}

export interface TicketParser {
  id: string;
  parse(rawText: string): ParsedTicket | null;
}
