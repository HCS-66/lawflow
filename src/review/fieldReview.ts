import { FieldEvidence, StandardTransaction, TransactionEvidenceField } from '../types/transaction';

export type RowReviewDecision = 'USE_ORIGINAL' | 'ACCEPT_CURRENT' | 'UNRESOLVED';

export function applyRowReviewDecision(
  transaction: StandardTransaction,
  fields: TransactionEvidenceField[],
  decision: RowReviewDecision,
  reviewedAt = new Date().toISOString(),
  reviewedBy = '律师人工核对'
): StandardTransaction {
  const next: StandardTransaction = {
    ...transaction,
    fieldEvidence: { ...(transaction.fieldEvidence || {}) }
  };
  let valueChanged = false;
  let acceptedSuggestion = false;

  for (const field of fields) {
    const currentValue = primitiveValue(next[field]);
    const existing = next.fieldEvidence?.[field] || extractedEvidence(currentValue, transaction.extractionConfidence);
    acceptedSuggestion ||= String(existing.originalValue ?? '') !== String(currentValue ?? '');

    if (decision === 'USE_ORIGINAL') {
      const originalValue = existing.originalValue;
      if (String(currentValue ?? '') !== String(originalValue ?? '')) valueChanged = true;
      assignField(next, field, originalValue);
      next.fieldEvidence![field] = reviewedEvidence(existing, originalValue, 'CONFIRMED', '律师对照原件确认原始识别值', reviewedBy, reviewedAt);
    } else if (decision === 'ACCEPT_CURRENT') {
      next.fieldEvidence![field] = reviewedEvidence(existing, currentValue, 'CONFIRMED', '律师对照原件确认当前结构化值', reviewedBy, reviewedAt);
    } else {
      next.fieldEvidence![field] = reviewedEvidence(existing, currentValue, 'UNRESOLVED', '原件不清晰或证据不足，暂时无法确认', reviewedBy, reviewedAt);
    }
  }

  if (decision === 'UNRESOLVED') {
    if (next.candidateReview) next.candidateReview = { ...next.candidateReview, status: 'UNRESOLVED', reviewedAt };
    next.reviewStatus = 'PENDING';
    next.reviewedAt = reviewedAt;
    next.lawyerNote = appendNote(next.lawyerNote, '本行原件不清晰，字段暂未确认');
    return next;
  }

  next.reviewStatus = valueChanged || acceptedSuggestion || transaction.reviewStatus === 'CORRECTED'
    ? 'CORRECTED'
    : 'VERIFIED';
  next.reviewedBy = reviewedBy;
  next.reviewedAt = reviewedAt;
  if (next.candidateReview) {
    const required: TransactionEvidenceField[] = next.candidateReview.kind === 'FIELD_CONFLICT' || next.candidateReview.kind === 'SOURCE_CHECK'
      ? [...new Set([...next.candidateReview.differences.map(item => item.field), ...(next.candidateReview.requiredFields || [])])]
      : ['accountNumber', 'transactionTime', 'direction', 'amount', 'balance', 'counterpartyName', 'counterpartyAccount', 'summary'];
    const resolved = required.every(field => next.fieldEvidence?.[field]?.decision === 'CONFIRMED'
      && next.fieldEvidence?.[field]?.reviewedBy === reviewedBy);
    next.candidateReview = { ...next.candidateReview, status: resolved ? 'CONFIRMED' : 'PENDING', reviewedAt };
  }
  next.lawyerNote = appendNote(next.lawyerNote, decision === 'USE_ORIGINAL'
    ? '律师确认采用原始识别值'
    : '律师确认当前结构化值与原件一致');
  if (fields.includes('transactionTime') && next.transactionTime) next.transactionDate = next.transactionTime.slice(0, 10);
  next.dataQualityIssues = (next.dataQualityIssues || []).filter(issue => {
    if (issue === 'INVALID_DATE' && (fields.includes('transactionTime') || fields.includes('transactionDate')) && /^20\d{2}-\d{2}-\d{2}/.test(next.transactionDate)) return false;
    if (issue === 'INVALID_AMOUNT' && fields.includes('amount') && Number.isFinite(next.amount) && next.amount >= 0) return false;
    if (issue === 'UNKNOWN_DIRECTION' && fields.includes('direction') && next.direction !== 'UNKNOWN') return false;
    return true;
  });
  if (next.dataQualityIssues.length || (next.candidateReview && next.candidateReview.status !== 'CONFIRMED')) next.reviewStatus = 'PENDING';
  return next;
}

function extractedEvidence(value: string | number | null, confidence?: number): FieldEvidence {
  return {
    originalValue: value,
    currentValue: value,
    confidence,
    origin: 'EXTRACTION',
    decision: 'UNRESOLVED'
  };
}

function reviewedEvidence(
  evidence: FieldEvidence,
  currentValue: string | number | null,
  decision: FieldEvidence['decision'],
  reason: string,
  reviewedBy: string,
  reviewedAt: string
): FieldEvidence {
  return {
    ...evidence,
    currentValue,
    origin: 'LAWYER_REVIEW',
    decision,
    reason,
    reviewedBy,
    reviewedAt
  };
}

function assignField(transaction: StandardTransaction, field: TransactionEvidenceField, value: string | number | null): void {
  if (field === 'amount' || field === 'balance') {
    transaction[field] = Number(value || 0);
  } else if (field === 'direction') {
    transaction.direction = value === 'IN' || value === 'OUT' ? value : 'UNKNOWN';
  } else {
    (transaction as unknown as Record<string, unknown>)[field] = String(value ?? '');
  }
}

function primitiveValue(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' || value === null ? value : String(value ?? '');
}

function appendNote(existing: string | undefined, note: string): string {
  if (!existing) return note;
  return existing.includes(note) ? existing : `${existing}；${note}`;
}
