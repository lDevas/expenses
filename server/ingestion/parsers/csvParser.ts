import Papa from 'papaparse';
import type { Transaction } from '../../../src/types/models.ts';
import { generateId, now } from '../../../src/types/models.ts';

export class CsvStatementParser {
  async parse(fileBuffer: Buffer, institutionId: string, options?: {
    delimiter?: string;
    encoding?: string;
    hasHeader?: boolean;
  }): Promise<Transaction[]> {
    try {
      const text = fileBuffer.toString(options?.encoding || 'utf-8');
      const delimiter = options?.delimiter || this.detectDelimiter(text);

      const result = Papa.parse(text, {
        delimiter,
        header: options?.hasHeader !== false,
        skipEmptyLines: true,
      });

      const rows = result.data as Record<string, string>[];
      return this.normalizeTransactions(rows, institutionId);
    } catch (error) {
      return [];
    }
  }

  private detectDelimiter(text: string): string {
    const firstLine = text.split('\n')[0];
    if (firstLine.includes('\t')) return '\t';
    if (firstLine.includes(';')) return ';';
    return ',';
  }

  private normalizeTransactions(rows: Record<string, string>[], institutionId: string): Transaction[] {
    const columns = Object.keys(rows[0] || {});
    const mapping = this.detectColumnMapping(columns, institutionId);

    return rows
      .filter(row => this.isValidTransaction(row, mapping))
      .map((row, i) => ({
        id: generateId(),
        accountId: this.detectAccountId(row, mapping, institutionId),
        date: this.parseDate(row[mapping.dateColumn || '']),
        postDate: mapping.postDateColumn ? this.parseDate(row[mapping.postDateColumn]) : undefined,
        description: (row[mapping.descriptionColumn || ''] || '').trim(),
        amount: this.parseAmount(row[mapping.amountColumn || '']),
        currency: mapping.currency || 'USD',
        category: this.categorize(row[mapping.descriptionColumn || '']),
        reference: row[mapping.referenceColumn || ''] || undefined,
        metadata: { institutionId, rawRow: row },
        source: 'ai-ingestion',
        importedAt: now(),
      }));
  }

  private detectColumnMapping(columns: string[], institutionId: string): {
    dateColumn?: string;
    postDateColumn?: string;
    descriptionColumn?: string;
    amountColumn?: string;
    currency?: string;
    referenceColumn?: string;
  } {
    const find = (keywords: string[]): string | undefined => {
      return columns.find(col =>
        keywords.some(kw => col.toLowerCase().includes(kw.toLowerCase()))
      );
    };

    return {
      dateColumn: find(['fecha', 'date', 'periodo']),
      postDateColumn: find(['fecha valor', 'value date', 'liquidacion']),
      descriptionColumn: find(['concepto', 'descrip', 'narrative', 'details']),
      amountColumn: find(['monto', 'amount', 'importe', 'valor']),
      currency: institutionId === 'etoro' || institutionId === 'interactive-brokers' ? 'USD' : 'UYU',
      referenceColumn: find(['referencia', 'ref', 'id', 'ticket']),
    };
  }

  private parseAmount(str: string): number {
    if (!str) return 0;
    const cleaned = str.replace(/\s/g, '').replace(/,/g, '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  private parseDate(str: string): Date {
    if (!str) return new Date();
    const parts = str.split(/[\/\-]/);
    if (parts.length === 3) {
      const [a, b, c] = parts.map(Number);
      if (a > 31) return new Date(a, b - 1, c);
      return new Date(c, b - 1, a);
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  private isValidTransaction(row: Record<string, string>, mapping: any): boolean {
    const amount = this.parseAmount(row[mapping.amountColumn || '']);
    return Math.abs(amount) > 0;
  }

  private categorize(description: string): string {
    const lower = description.toLowerCase();
    if (lower.includes('debito') || lower.includes('cargo') || lower.includes('fee')) return 'expense';
    if (lower.includes('credito') || lower.includes('abono') || lower.includes('deposit')) return 'income';
    if (lower.includes('transfer') || lower.includes('transf')) return 'transfer';
    return 'other';
  }

  private detectAccountId(row: Record<string, string>, mapping: any, institutionId: string): string {
    return `${institutionId}-primary`;
  }
}
