import type { CounterpartySummary, StandardTransaction } from '../types/transaction';

/** Complete account digits identify an account across name variants; masks/tails do not. */
export function counterpartyIdentityKey(transaction: StandardTransaction, fallbackName = transaction.counterpartyName?.trim() || ''): string {
  const account = (transaction.counterpartyAccount || '').replace(/\s/g, '');
  const name = /^【(?:无对手方|.*用途待核对)/.test(fallbackName) ? '' : fallbackName;
  if (/^\d{12,32}$/.test(account) && !/^0+$/.test(account)) return `account:${account}`;
  if (account) return JSON.stringify(['local-identifier', transaction.counterpartyBank || transaction.bankName, account, name]);
  return name || `unknown:${transaction.sourceDocumentId || transaction.rawSourceFile}:${transaction.id}`;
}

export function summaryForCounterparty(transaction: StandardTransaction, summaries: Record<string, CounterpartySummary>) {
  return summaries[counterpartyIdentityKey(transaction)] || summaries[transaction.counterpartyName?.trim() || ''];
}
