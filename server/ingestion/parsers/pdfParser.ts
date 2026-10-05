import { PDFParse } from 'pdf-parse';
import type { Transaction } from '../../../src/types/models.ts';
import { generateId, now } from '../../../src/types/models.ts';

interface RawTransaction {
  operacionDate: string;
  valorDate: string;
  description: string;
  amount: number;
  balance: number;
}

interface Account {
  id: string;
  institutionId: string;
  name: string;
  type: string;
  currency: string;
  balance: number;
  balanceDate: Date;
}

export class PdfStatementParser {
  async parse(fileBuffer: Buffer, institutionId: string): Promise<Transaction[]> {
    const parser = new PDFParse({ data: fileBuffer });
    try {
      const { text } = await parser.getText();
      const transactions = this.extractTransactions(text, institutionId);
      return this.normalizeTransactions(transactions, institutionId);
    } catch (error) {
      return [];
    } finally {
      parser.destroy();
    }
  }

  private extractTransactions(text: string, institutionId: string): RawTransaction[] {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const transactions: RawTransaction[] = [];

    const datePattern = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+([\d.,-]+)\s+([\d.,-]+)/;

    for (const line of lines) {
      const match = line.match(datePattern);
      if (match) {
        transactions.push({
          operacionDate: match[1],
          valorDate: match[2],
          description: line.substring(match[0].indexOf(match[3]), line.lastIndexOf(match[4])).trim(),
          amount: parseFloat(match[3].replace(',', '')),
          balance: parseFloat(match[4].replace(',', '')),
        });
      }
    }

    return transactions;
  }

  private normalizeTransactions(raw: RawTransaction[], institutionId: string): Transaction[] {
    const accounts = this.detectAccounts(raw);

    return raw.map((r, i) => ({
      id: generateId(),
      accountId: accounts[0].id,
      date: this.parseDate(r.operacionDate),
      postDate: this.parseDate(r.valorDate),
      description: r.description.replace(/\s+/g, ' ').trim(),
      amount: r.amount,
      currency: 'UYU',
      category: this.categorize(r.description),
      reference: `SANT-${i + 1}`,
      metadata: { rawLine: this.rawLine(raw, institutionId), institutionId },
      source: 'ai-ingestion',
      importedAt: now(),
    }));
  }

  private parseDate(str: string): Date {
    const [day, month, year] = str.split('/').map(Number);
    return new Date(year, month - 1, day);
  }

  private categorize(description: string): string {
    const lower = description.toLowerCase();
    if (lower.includes('debito') || lower.includes('cargo')) return 'expense';
    if (lower.includes('credito') || lower.includes('abono')) return 'income';
    if (lower.includes('transfer')) return 'transfer';
    if (lower.includes('pos') || lower.includes('terminal')) return 'purchase';
    return 'other';
  }

  private detectAccounts(raw: RawTransaction[]): Account[] {
    return [{
      id: generateId(),
      institutionId: 'santander-uy',
      name: 'Cuenta Corriente',
      type: 'checking',
      currency: 'UYU',
      balance: 0,
      balanceDate: new Date(),
    }];
  }

  private rawLine(raw: RawTransaction[], institutionId: string): string {
    return JSON.stringify(raw.map(r => ({ ...r, description: r.description.substring(0, 50) })));
  }
}
