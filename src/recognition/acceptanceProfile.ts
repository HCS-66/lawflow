import type { QualityTruthRow } from './acceptanceEvaluation';
import type { StatementColumn } from './sourceAssembly';

/** Frozen business scope: date, identity, money and analysis-relevant transaction class. */
export const ENFORCEMENT_ACCEPTANCE_PROFILE = 'ENFORCEMENT_V1';
export function enforcementTruthProfile(row: QualityTruthRow): QualityTruthRow {
  const criticalFields: StatementColumn[] = ['accountNumber', 'transactionDate', 'direction', 'amount', 'balance',
    'counterpartyAccount', 'transactionType'];
  if (!row.values[10] && row.values[9]) criticalFields.push('counterpartyName');
  // Both are ordinary expenditure for this product's funds analysis. No identity or money relaxation.
  const ordinaryExpense = ['消费', '缴费'].includes(row.values[8]);
  return { ...row, criticalFields, allowedValues: ordinaryExpense ? { transactionType: ['消费', '缴费'] } : undefined };
}
