import type { ParsedStatement } from '../types.ts';
import { toISODate } from '../types.ts';
import { classifyItauConcept } from '../parsers/itauEstadoXls.ts';
import { classifySantanderConcept } from '../parsers/santanderUmsatz.ts';
import { classifyPrexDescription } from '../parsers/prexXlsx.ts';

/** Reapply bank semantics to archived sources as well as newly parsed statements. */
export function normalizeMovements(statements: ParsedStatement[]): ParsedStatement[] {
  return statements.map(s => {
    const transactions = s.transactions.map(t => {
      const raw = t.metadata?.raw as Record<string, unknown> | undefined;
      if (!raw) return t;
      const classification = s.kind === 'itau-estado' && typeof raw.concepto === 'string'
        ? classifyItauConcept(raw.concepto, String(raw.referencia ?? ''), String(raw.destino ?? ''))
        : s.kind === 'santander-umsatz' && typeof raw.concepto === 'string'
          ? classifySantanderConcept([raw.concepto, raw.descripcion].filter(Boolean).join(' '), t.amount)
          : s.kind === 'prex-estado' && typeof raw.descripcion === 'string'
            ? classifyPrexDescription(raw.descripcion, t.amount)
            : undefined;
      return classification ? { ...t, kind: classification[0], counterparty: classification[1] } : t;
    });
    if (s.kind === 'santander-umsatz') {
      // Santander emits a separate TRANSFERENCIA ENVIADA charge beside the
      // actual digital debit with the same operation reference. It is a fee,
      // including for own-account transfers; never hide it as moved principal.
      const principals = new Set(transactions.filter(t => t.amount < 0 && t.reference &&
        /^(?:DEBITO OPERACION|DB\. PAGO SUELDOS)/i.test(t.description) && /TRF\. PLAZA/i.test(t.description))
        .map(t => `${toISODate(t.date)}:${t.reference}`));
      return { ...s, transactions: transactions.map(t =>
        t.amount < 0 && t.reference && /^TRANSFERENCIA ENVIADA/i.test(t.description) &&
        principals.has(`${toISODate(t.date)}:${t.reference}`) ? { ...t, kind: 'fee' as const } : t) };
    }
    return { ...s, transactions };
  });
}
