import ExcelJS from 'exceljs';
import type { Transaction } from '../../../src/types/models.ts';
import { generateId, now } from '../../../src/types/models.ts';

export class ExcelStatementParser {
  async parse(fileBuffer: Buffer, institutionId: string): Promise<Transaction[]> {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(fileBuffer);

      const worksheet = workbook.worksheets[0];
      if (!worksheet) return [];

      const rows: Record<string, string>[] = [];
      let isFirstRow = true;

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const rowData: Record<string, string> = {};
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const value = this.formatCellValue(cell.value);
          if (isFirstRow) {
            rowData[cell.text || `col_${colNumber}`] = value;
          } else {
            const header = Object.keys(rowData)[colNumber - 1];
            if (header) {
              rowData[header] = value;
            }
          }
        });
        if (isFirstRow) isFirstRow = false;
        if (Object.keys(rowData).length > 0) rows.push(rowData);
      });

      return this.normalizeTransactions(rows, institutionId);
    } catch (error) {
      return [];
    }
  }

  private formatCellValue(value: any): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().split('T')[0];
    if (typeof value === 'number') {
      if (value < 100000) {
        const d = ExcelJS.Date.fromExcel(value);
        return d.toISOString().split('T')[0];
      }
      return value.toString();
    }
    return String(value);
  }

  private normalizeTransactions(rows: Record<string, string>[], institutionId: string): Transaction[] {
    const columns = Object.keys(rows[0] || {});
    const mapping = this.detectColumnMapping(columns, institutionId);

    return rows
      .filter(row => this.isValidTransaction(row, mapping))
      .map((row, i) => ({
        id: generateId(),
        accountId: `${institutionId}-primary`,
        date: this.parseDate(row[mapping.dateColumn || '']),
        postDate: mapping.postDateColumn ? this.parseDate(row[mapping.postDateColumn]) : undefined,
        description: (row[mapping.descriptionColumn || ''] || '').trim(),
        amount: this.parseAmount(row[mapping.amountColumn || '']),
        currency: institutionId === 'etoro' || institutionId === 'interactive-brokers' ? 'USD' : 'UYU',
        category: this.categorize(row[mapping.descriptionColumn || '']),
        reference: row[mapping.referenceColumn || ''] || undefined,
        metadata: { institutionId, rawRow: row },
        source: 'ai-ingestion',
        importedAt: now(),
      }));
  }

  private detectColumnMapping(columns: string[], institutionId: string): any {
    const find = (keywords: string[]): string | undefined => {
      return columns.find(col =>
        keywords.some(kw => col.toLowerCase().includes(kw.toLowerCase()))
      );
    };

    return {
      dateColumn: find(['fecha', 'date', 'periodo']),
      postDateColumn: find(['fecha valor', 'value date', 'liquidacion']),
      descriptionColumn: find(['concepto', 'descrip', 'narrative', 'details']),
      amountColumn: find(['monto', 'amount', 'importe', 'value', 'total']),
      currency: institutionId === 'etoro' || institutionId === 'interactive-brokers' ? 'USD' : 'UYU',
      referenceColumn: find(['referencia', 'ref', 'id', 'ticket']),
    };
  }

  private parseAmount(str: string): number {
    if (!str) return 0;
    const cleaned = String(str).replace(/\s/g, '').replace(/,/g, '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  private parseDate(str: string): Date {
    if (!str) return new Date();
    const parts = String(str).split(/[\/\-]/);
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
}
