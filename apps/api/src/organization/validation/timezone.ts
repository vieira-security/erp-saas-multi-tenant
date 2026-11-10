/**
 * Timezone IANA real (ex.: `America/Sao_Paulo`), nunca offset fixo. Usa o banco de fusos do ICU do Node:
 * - aceita nomes canônicos e aliases (`Brazil/East`, `america/sao_paulo`) e devolve o nome CANÔNICO para gravar;
 * - aceita `UTC` (e `Etc/UTC`/`GMT`, gravados como `UTC`);
 * - rejeita offsets (`-03:00`, `GMT-3`, `UTC-3`) e zonas `Etc/GMT±N` (offset fixo disfarçado de nome).
 */

let canonical: ReadonlySet<string> | undefined;

function canonicalZones(): ReadonlySet<string> {
  canonical ??= new Set(Intl.supportedValuesOf("timeZone"));
  return canonical;
}

export type TimezoneCheck = { ok: true; value: string } | { ok: false };

export function checkTimezone(input: string): TimezoneCheck {
  if (input.length === 0 || input.length > 64 || input !== input.trim()) return { ok: false };
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: input }).resolvedOptions().timeZone;
  } catch {
    return { ok: false };
  }
  if (resolved === "UTC" || canonicalZones().has(resolved)) return { ok: true, value: resolved };
  return { ok: false };
}
