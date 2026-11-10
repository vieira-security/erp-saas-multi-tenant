/**
 * Dia de operação (`YYYY-MM-DD`) de um instante no fuso IANA da filial (`branches.timezone`, validado no M3). É o dia do
 * contador do número do pedido: o número reinicia quando o dia vira NO FUSO DA FILIAL, nunca em UTC.
 * Ex.: 2026-11-09T02:59Z em America/Sao_Paulo (UTC-3) = 2026-11-08; 03:00Z = 2026-11-09.
 */
export function businessDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: "year" | "month" | "day") => {
    const value = parts.find((p) => p.type === type)?.value;
    if (!value) throw new Error(`cannot compute ${type} in ${timeZone}`);
    return value;
  };
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** `YYYY-MM-DD` de calendário real (rejeita `2026-02-30`). */
export function isCalendarDate(value: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

/** `YYYY-MM-DD` -> valor de coluna `date` para o Prisma (meia-noite UTC; `@db.Date` descarta a hora). */
export function dateColumn(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Valor lido de coluna `date` -> `YYYY-MM-DD`. */
export function fromDateColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}
