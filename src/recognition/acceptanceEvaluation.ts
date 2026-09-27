import { STATEMENT_COLUMNS, moneyFromSource, type StatementColumn } from './sourceAssembly';

export interface QualityRow { id: string; values: string[]; sourceObservationIds: string[] }
export interface QualityTruthRow extends QualityRow {
  /** Frozen by the human annotator before scoring. Defaults cover all dates. */
  criticalFields?: StatementColumn[];
  allowedValues?: Partial<Record<StatementColumn, string[]>>;
}
export interface QualityAlert {
  id: string;
  rowIds: string[];
  sourceObservationIds: string[];
  fields: Array<StatementColumn | 'ROW'>;
  reason: string;
  required: boolean;
}
export interface QualityAlignment { expectedId: string; actualId: string }
export interface AcceptanceProtocol {
  kind: 'REGRESSION' | 'BLIND';
  annotationsComplete: boolean;
  sourceAlignmentVerified: boolean;
  predictionsFrozenBeforeEvaluation: boolean;
  processingComplete: boolean;
}

function equal(field: StatementColumn, expected: string, actual: string): boolean {
  if (field === 'amount' || field === 'balance') {
    const left = moneyFromSource(expected, field === 'amount');
    const right = moneyFromSource(actual, field === 'amount');
    return left !== null && right !== null && left === right;
  }
  // Equivalence beyond exact text must be explicitly in the frozen annotation.
  return expected === actual;
}

/** Scoring only: never used by a recognizer or alert generator. */
export function evaluateProductAcceptance(expected: QualityTruthRow[], actual: QualityRow[],
  alignment: QualityAlignment[], alerts: QualityAlert[], protocol: AcceptanceProtocol) {
  const index = <T extends QualityRow>(rows: T[]) => {
    const map = new Map<string, T>();
    for (const row of rows) {
      if (!row.id || map.has(row.id) || row.values.length !== 12 || !row.values.every(v => typeof v === 'string')) throw new Error('Invalid or duplicate evaluation row');
      map.set(row.id, row);
    }
    return map;
  };
  const gold = index(expected), output = index(actual);
  const actualForExpected = new Map<string, string>(), expectedForActual = new Map<string, string>();
  for (const link of alignment) {
    if (!gold.has(link.expectedId) || !output.has(link.actualId) || actualForExpected.has(link.expectedId)
      || expectedForActual.has(link.actualId)) throw new Error('Alignment must be one-to-one and refer to existing rows');
    actualForExpected.set(link.expectedId, link.actualId);
    expectedForActual.set(link.actualId, link.expectedId);
  }
  type Error = { kind: 'FIELD' | 'MISSING_ROW' | 'EXTRA_ROW'; expectedId?: string; actualId?: string;
    field: StatementColumn | 'ROW'; expected?: string; actual?: string; alerted: boolean };
  const errors: Error[] = [];
  let correctRows = 0;
  const required = alerts.filter(a => a.required);
  const actualRowsToReview = new Set<string>(), expectedRowsToReview = new Set<string>();
  const sourceOverlap = (a: string[], b: string[]) => a.some(s => b.includes(s));
  for (const alert of required) {
    for (const id of alert.rowIds) {
      if (!output.has(id)) throw new Error('Alert refers to nonexistent output row');
      actualRowsToReview.add(id);
      const expectedId = expectedForActual.get(id);
      if (expectedId) expectedRowsToReview.add(expectedId);
    }
    for (const row of expected) if (sourceOverlap(row.sourceObservationIds, alert.sourceObservationIds)) expectedRowsToReview.add(row.id);
    for (const row of actual) if (sourceOverlap(row.sourceObservationIds, alert.sourceObservationIds)) actualRowsToReview.add(row.id);
  }
  const covered = (field: StatementColumn | 'ROW', truth?: QualityRow, row?: QualityRow) => required.some(alert => {
    // A generic row warning does not prove a specific field error was found.
    if (!alert.reason.trim() || !alert.sourceObservationIds.length || !alert.fields.includes(field)) return false;
    const location = sourceOverlap(alert.sourceObservationIds, truth?.sourceObservationIds || [])
      || sourceOverlap(alert.sourceObservationIds, row?.sourceObservationIds || []);
    return location && (!row || alert.rowIds.includes(row.id) || sourceOverlap(alert.sourceObservationIds, row.sourceObservationIds));
  });
  for (const truth of expected) {
    const row = output.get(actualForExpected.get(truth.id) || '');
    if (!row) {
      errors.push({ kind: 'MISSING_ROW', expectedId: truth.id, field: 'ROW', alerted: covered('ROW', truth) });
      continue;
    }
    const critical = truth.criticalFields || ['accountNumber', 'transactionDate', 'direction', 'amount', 'balance', 'counterpartyAccount',
      ...(!truth.values[10] && truth.values[9] ? ['counterpartyName' as const] : [])];
    let correct = true;
    for (const field of critical) {
      const column = STATEMENT_COLUMNS.indexOf(field);
      if (column < 0) throw new Error('Unknown critical field');
      const target = truth.values[column], value = row.values[column];
      if (equal(field, target, value) || truth.allowedValues?.[field]?.some(v => equal(field, v, value))) continue;
      correct = false;
      errors.push({ kind: 'FIELD', expectedId: truth.id, actualId: row.id, field, expected: target, actual: value, alerted: covered(field, truth, row) });
    }
    if (correct) correctRows++;
  }
  for (const row of actual) if (!expectedForActual.has(row.id)) errors.push({ kind: 'EXTRA_ROW', actualId: row.id, field: 'ROW', alerted: covered('ROW', undefined, row) });
  // Each aligned transaction counts once; extra output transactions still cost review effort.
  for (const id of actualRowsToReview) {
    const expectedId = expectedForActual.get(id);
    if (expectedId) expectedRowsToReview.add(expectedId);
  }
  const reviewedExtra = [...actualRowsToReview].filter(id => !expectedForActual.has(id)).length;
  const manualRows = expectedRowsToReview.size + reviewedExtra;
  const denominator = Math.max(expected.length, actual.length);
  const initialCriticalAccuracy = denominator ? correctRows / denominator : null;
  const manualReviewRate = expected.length ? manualRows / expected.length : null;
  const missed = errors.filter(e => !e.alerted);
  const metricPass = protocol.processingComplete && initialCriticalAccuracy !== null && initialCriticalAccuracy >= .995
    && manualReviewRate !== null && manualReviewRate <= .05 && missed.length === 0;
  return { expectedRows: expected.length, outputRows: actual.length, correctRows, initialCriticalAccuracy,
    manualRows, manualReviewRate, criticalErrorCount: errors.length,
    unalertedCriticalErrorCount: missed.length, detectionRate: errors.length ? (errors.length - missed.length) / errors.length : null,
    meetsObservedThresholds: metricPass,
    blindAcceptancePassed: metricPass && protocol.kind === 'BLIND' && protocol.annotationsComplete
      && protocol.sourceAlignmentVerified && protocol.predictionsFrozenBeforeEvaluation && protocol.processingComplete,
    protocol, errors };
}
