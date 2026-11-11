import type { KitchenTicketStatus } from "@erp/contracts";

/**
 * Texto da comanda para a térmica de 80 mm impressa pelo navegador (contrato `KitchenTicketPrintDto.lines`). Função PURA:
 * cada linha com no máximo 48 caracteres (code points, depois de NFC), acentos mantidos, sem preços. Reaproveitável pelo
 * futuro agente ESC/POS.
 *
 *   *** CANCELADO ***        (comanda CANCELLED)
 *         2ª VIA             (via >= 2)
 *         COZINHA            (setor)
 *        PEDIDO #12
 *   10/11/2026 14:35         (criação da comanda, fuso da filial)
 *   ================================================
 *   2x X-Burger
 *      Tamanho: G            (opções indentadas, na ordem do pedido)
 *      OBS: sem cebola
 *   ================================================
 *   - - - - - - - - - - - - - - - - - - - - - - - -   (linha de corte)
 */

export const PRINT_WIDTH = 48;
export const CANCELLED_BANNER = "*** CANCELADO ***";
export const COPY_BANNER = "2ª VIA";
const SEPARATOR = "=".repeat(PRINT_WIDTH);
export const CUT_LINE = "- ".repeat(PRINT_WIDTH / 2).trimEnd();
const INDENT = "   ";

export interface PrintableItem {
  readonly quantity: number;
  readonly productName: string;
  readonly options: readonly { readonly groupName: string; readonly name: string }[];
  readonly note: string | null;
}

export interface PrintableTicket {
  readonly sectorName: string;
  readonly orderNumber: number;
  readonly createdAt: Date;
  /** Fuso IANA da filial (`branches.timezone`). */
  readonly timeZone: string;
  readonly status: KitchenTicketStatus;
  /** Via desta impressão (1 = original). */
  readonly copyNumber: number;
  readonly items: readonly PrintableItem[];
}

/** Texto em uma linha: NFC, qualquer sequência de espaços/quebras vira um espaço, sem espaços nas pontas. */
function clean(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function width(text: string): number {
  return [...text].length;
}

/**
 * Quebra por palavras sem passar de `PRINT_WIDTH`: a primeira linha começa com `first`, as seguintes com `next`
 * (recuo). Palavra maior que o espaço disponível é cortada por caractere.
 */
export function wrap(text: string, first = "", next = first): string[] {
  const lines: string[] = [];
  let prefix = first;
  let line = "";
  const flush = () => {
    lines.push(prefix + line);
    prefix = next;
    line = "";
  };
  for (const word of clean(text).split(" ").filter((w) => w !== "")) {
    let rest = [...word];
    while (rest.length > 0) {
      const room = PRINT_WIDTH - width(prefix) - (line === "" ? 0 : width(line) + 1);
      if (rest.length <= room) {
        line = line === "" ? rest.join("") : `${line} ${rest.join("")}`;
        rest = [];
      } else if (line !== "") {
        flush();
      } else {
        const fits = Math.max(1, PRINT_WIDTH - width(prefix));
        line = rest.slice(0, fits).join("");
        rest = rest.slice(fits);
        flush();
      }
    }
  }
  if (line !== "" || lines.length === 0) flush();
  return lines.map((l) => l.trimEnd());
}

function centered(text: string): string[] {
  return wrap(text).map((line) => " ".repeat(Math.floor((PRINT_WIDTH - width(line)) / 2)) + line);
}

/** `dd/mm/aaaa hh:mm` (24 h) no fuso da filial. */
export function localDateTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

export function ticketLines(ticket: PrintableTicket): string[] {
  const lines: string[] = [];
  if (ticket.status === "CANCELLED") lines.push(...centered(CANCELLED_BANNER));
  if (ticket.copyNumber >= 2) lines.push(...centered(COPY_BANNER));
  lines.push(...centered(ticket.sectorName.toLocaleUpperCase("pt-BR")));
  lines.push(...centered(`PEDIDO #${ticket.orderNumber}`));
  lines.push(localDateTime(ticket.createdAt, ticket.timeZone));
  lines.push(SEPARATOR);
  for (const item of ticket.items) {
    const head = `${item.quantity}x `;
    lines.push(...wrap(item.productName, head, " ".repeat(width(head))));
    for (const option of item.options) lines.push(...wrap(`${option.groupName}: ${option.name}`, INDENT, `${INDENT}  `));
    if (item.note !== null) lines.push(...wrap(`OBS: ${item.note}`, INDENT, `${INDENT}  `));
  }
  lines.push(SEPARATOR);
  lines.push(CUT_LINE);
  return lines;
}
