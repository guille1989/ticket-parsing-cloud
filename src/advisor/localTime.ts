/** Fecha local `yyyy-MM-dd` de un instante en una zona IANA. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** Minuto local (0-59): hay zonas con desfase de media hora, así que no equivale al minuto UTC. */
export function localMinute(instant: Date, timeZone: string): number {
  const minute = new Intl.DateTimeFormat("en-US", { timeZone, minute: "2-digit" })
    .formatToParts(instant)
    .find((part) => part.type === "minute")?.value;
  return Number(minute);
}

/** Hora local (0-23) de un instante en una zona IANA. */
export function localHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(instant)
    .find((part) => part.type === "hour")?.value;
  return Number(hour);
}
