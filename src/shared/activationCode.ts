import { randomInt } from "node:crypto";

// Excluye 0/O, 1/I/L y vocales+consonantes que se confunden leídas en voz
// alta o tipeadas a mano por quien instala el agente — no es un alfabeto
// base32 estándar, es el mismo criterio (evitar ambigüedad visual) aplicado
// a mano.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GROUP_LENGTH = 5;

/** `XXXXX-XXXXX`, ~50 bits de entropía — no hace falta que expire (ver ActivationCodeRecord). */
export const ACTIVATION_CODE_PATTERN = /^[A-Z2-9]{5}-[A-Z2-9]{5}$/;

function randomGroup(): string {
  let group = "";
  for (let i = 0; i < GROUP_LENGTH; i++) {
    group += ALPHABET[randomInt(ALPHABET.length)];
  }
  return group;
}

export function generateActivationCode(): string {
  return `${randomGroup()}-${randomGroup()}`;
}
