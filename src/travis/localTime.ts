/** Fecha local `yyyy-MM-dd` de un instante en una zona IANA. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** Hora local (0-23) de un instante en una zona IANA. */
export function localHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(instant)
    .find((part) => part.type === "hour")?.value;
  return Number(hour);
}
