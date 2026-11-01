const VOLUME_PATTERN = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(ML|CC|LTS?|LITROS?|L|KG|GRS?|G|ONZ|OZ)(?![A-Za-zÁ-ú])/i;

const UNIT_ALIASES: Record<string, string> = {
  LT: "L",
  LTS: "L",
  LITRO: "L",
  LITROS: "L",
  GR: "G",
  GRS: "G",
};

/**
 * Volumen o peso que trae el nombre de un producto ("AGUA TRATADA 350 ML SIN
 * GAS" → "350 ML"). Lo extrae el servidor para que el asistente muestre el
 * volumen en su propia columna sin tener que interpretar el texto. Undefined
 * si el nombre no trae medida.
 */
export function extractProductVolume(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = VOLUME_PATTERN.exec(description);
  if (!match) return undefined;
  const unit = match[2].toUpperCase();
  return `${match[1].replace(",", ".")} ${UNIT_ALIASES[unit] ?? unit}`;
}
