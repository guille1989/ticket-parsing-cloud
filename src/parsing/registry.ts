import { example38ColParser } from "./parsers/example38col.js";
import { TicketParser } from "./types.js";

/**
 * A diferencia del agente local (que probaba cada parser hasta encontrar
 * uno que matcheara), acá cada tenant ya tiene un `parserId` asignado en
 * la tabla Tenants — el dispatch es directo, sin adivinar.
 */
const parsers: Record<string, TicketParser> = {
  [example38ColParser.id]: example38ColParser,
};

export function getParser(parserId: string): TicketParser | undefined {
  return parsers[parserId];
}
