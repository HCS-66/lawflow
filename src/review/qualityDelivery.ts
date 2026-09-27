import type { AssemblyIssue, SourceRegistry } from '../recognition/sourceAssembly';
import type { QualityRow } from '../recognition/acceptanceEvaluation';

export interface QualityDeliveryInput { complete: boolean; rows: QualityRow[]; pending: AssemblyIssue[] }
export interface QualityResolution { issueId: string; status: 'CONFIRMED' | 'CORRECTED' | 'UNRESOLVED';
  reviewer: string; reviewedAt: string; note: string }

/** Required checks remain required even when balances agree or another field on that row was reviewed. */
export function qualityDeliveryStatus(input: QualityDeliveryInput, resolutions: QualityResolution[] = []) {
  const known = new Set(input.pending.map(issue => issue.id));
  if (new Set(input.pending.map(issue => issue.id)).size !== input.pending.length) throw new Error('Duplicate review issue IDs');
  const accepted = new Map<string, QualityResolution>();
  for (const resolution of resolutions) {
    if (!known.has(resolution.issueId) || accepted.has(resolution.issueId)) throw new Error('Invalid or duplicate review resolution');
    if (!resolution.reviewer.trim() || !resolution.reviewedAt.trim()) throw new Error('Review must record a reviewer and time');
    accepted.set(resolution.issueId, resolution);
  }
  const pending = input.pending.filter(issue => issue.severity !== 'ADVISORY'
    && !['CONFIRMED', 'CORRECTED'].includes(accepted.get(issue.id)?.status || ''));
  const status = !input.complete ? 'INCOMPLETE' : pending.length ? 'NEEDS_REVIEW' : 'READY';
  return { status, pending, requiredRowCount: new Set(pending.flatMap(issue => issue.outputRows)).size,
    documentCheckCount: pending.filter(issue => !issue.outputRows.length).length,
    canExportAsFinal: status === 'READY', canExportAsDraft: true };
}

/** Classification uncertainty is a field-specific check, including when the money columns balance. */
export function withAnalysisTypeChecks<T extends QualityDeliveryInput>(input: T, registry: SourceRegistry): T {
  const result = structuredClone(input);
  for (const [index, row] of result.rows.entries()) {
    if (row.values[8] || result.pending.some(issue => issue.field === 'transactionType' && issue.outputRows.includes(index + 1))) continue;
    const sourceRows = row.sourceObservationIds.filter(id => /^source:\d+$/.test(id)).map(id => Number(id.slice(7)))
      .filter(id => registry.rows[id]);
    result.pending.push({ id: `TYPE_UNRESOLVED_${row.id}`, code: 'ANALYSIS_TYPE_UNRESOLVED', field: 'transactionType',
      outputRows: [index + 1], sourceRows, sourceCells: [], severity: 'REQUIRED',
      message: '原文用途尚不能归入标准交易类型，请核对这一笔的用途；金额及余额相符不能确认用途' });
  }
  return result;
}
