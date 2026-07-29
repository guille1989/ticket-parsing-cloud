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
  total: number;
  timestamp: string; // ISO 8601
}

export interface TicketParser {
  id: string;
  parse(rawText: string): ParsedTicket | null;
}
