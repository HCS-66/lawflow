import { CaseMetadata } from '../types/case';
import { BankAccount, StandardTransaction } from '../types/transaction';

const ANALYSIS_MODEL_VERSION = '2026-09-account-priority-identity-v6';

function stableHash(input: string): string {
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 16777619);
    right ^= code + index;
    right = Math.imul(right, 3266489909);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

/** Fingerprints only canonical facts and analysis configuration, never derived tags. */
export function caseAnalysisFingerprint(
  caseMeta: CaseMetadata,
  transactions: StandardTransaction[],
  accounts: BankAccount[],
  ruleSignature = ''
): string {
  const canonicalTransactions = [...transactions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(transaction => ({
      id: transaction.id,
      sourceDocumentId: transaction.sourceDocumentId || '',
      rawSourceFile: transaction.rawSourceFile,
      accountNumber: transaction.accountNumber,
      accountName: transaction.accountName,
      bankName: transaction.bankName,
      transactionTime: transaction.transactionTime,
      transactionDate: transaction.transactionDate,
      direction: transaction.direction,
      amount: transaction.amount,
      balance: transaction.balance,
      balanceAvailable: transaction.balanceAvailable !== false,
      counterpartyName: transaction.counterpartyName,
      counterpartyAccount: transaction.counterpartyAccount || '',
      counterpartyBank: transaction.counterpartyBank || '',
      summary: transaction.summary,
      transactionType: transaction.transactionType || '',
      rawText: transaction.rawText || '',
      counterpartyRoleTag: transaction.counterpartyRoleTag || '',
      reviewStatus: transaction.reviewStatus || '',
      duplicateOfTransactionId: transaction.duplicateOfTransactionId || '',
      excludedFromAnalysis: transaction.excludedFromAnalysis === true
    }));
  const canonicalAccounts = [...accounts]
    .sort((left, right) => `${left.sourceDocumentId || ''}|${left.accountNumber}`.localeCompare(`${right.sourceDocumentId || ''}|${right.accountNumber}`))
    .map(account => ({
      sourceDocumentId: account.sourceDocumentId || '',
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      bankName: account.bankName,
      ownerType: account.ownerType,
      startBalance: account.startBalance,
      endBalance: account.endBalance,
      balanceAvailable: account.balanceAvailable !== false
    }));
  const input = JSON.stringify({
    analysisModelVersion: ANALYSIS_MODEL_VERSION,
    caseId: caseMeta.id,
    respondentName: caseMeta.respondentName,
    targetAmount: caseMeta.targetAmount,
    timeline: caseMeta.timeline,
    declaredAssets: caseMeta.declaredAssets,
    transactions: canonicalTransactions,
    accounts: canonicalAccounts,
    ruleSignature
  });
  return `analysis_${stableHash(input)}`;
}
