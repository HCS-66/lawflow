import type { IndependentPage } from './independentComparison';

export const QUALITY_REVISION = 'gemini-preflight-qwen-source-gemini-mapping-v1';
export const QUALITY_STAGES = ['preflight', 'primary', 'context', 'independent', 'mapping', 'primaryRecovery', 'accounts', 'critical'] as const;
export type QualityStage = typeof QUALITY_STAGES[number];
export interface VerbatimPage { nearTableText: string[]; tables: Array<{ rows: string[][] }> }
export interface PreflightReading { pageKind: 'blank' | 'content' | 'uncertain'; uprightCandidate: 'A' | 'B' | 'C' | 'D' | 'uncertain'; reason: string }
export interface PageMetrics { darkFraction160: number; darkFraction210: number; hasPdfText: boolean }
export interface ModelReply { result: any; finishReason: string; model: string; usage?: unknown; promptSHA256: string }
export interface QualityRequest { stage: QualityStage; images?: string[]; source?: unknown }
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const exactKeys = (v: any, keys: string[]) => v && Object.keys(v).sort().join(',') === keys.sort().join(',');

export function validateQualityResult(stage: QualityStage, value: any): void {
  if (!value || typeof value !== 'object') throw new Error('模型未返回完整对象');
  if (stage === 'preflight') {
    if (!exactKeys(value, ['pageKind', 'uprightCandidate', 'reason']) || !['blank', 'content', 'uncertain'].includes(value.pageKind)
      || !['A', 'B', 'C', 'D', 'uncertain'].includes(value.uprightCandidate) || typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('页面检查结果不完整');
  } else if (['primary', 'primaryRecovery', 'context'].includes(stage)) {
    if (!exactKeys(value, ['nearTableText', 'tables']) || !strings(value.nearTableText) || !Array.isArray(value.tables)
      || !value.tables.every((t: any) => exactKeys(t, ['rows']) && Array.isArray(t.rows) && t.rows.every(strings))
      || stage === 'context' && value.tables.length) throw new Error('原文表格结构不完整');
  } else if (stage === 'independent' || stage === 'critical') {
    const v = value as IndependentPage;
    if (!['transactions', 'account_info', 'document', 'blank', 'uncertain'].includes(v.pageType)
      || !['complete', 'uncertain'].includes(v.coverage) || !strings(v.pageIssues) || !Array.isArray(v.rows)
      || v.rows.some((r, i) => r.row !== i + 1 || !strings(r.values) || r.values.length !== 8 || typeof r.rawDirection !== 'string'
        || !Array.isArray(r.issues) || r.issues.some(x => !['accountNumber', 'transactionDate', 'transactionTime', 'direction', 'amount', 'balance', 'counterpartyName', 'counterpartyAccount'].includes(x.field)
          || !['uncertain', 'truncated', 'unreadable'].includes(x.kind) || typeof x.reason !== 'string'))
      || v.rows.length && v.pageType !== 'transactions'
      || v.bankName !== undefined && typeof v.bankName !== 'string'
      || v.ownerNames !== undefined && !strings(v.ownerNames)
      || v.ownerIdentifiers !== undefined && (!Array.isArray(v.ownerIdentifiers) || v.ownerIdentifiers.some(x => !['account', 'card'].includes(x.role) || typeof x.value !== 'string'))) throw new Error('独立读取结果不完整');
  } else if (stage === 'mapping') {
    if (!Array.isArray(value.tables) || !Array.isArray(value.typeRules)) throw new Error('整理结果不完整');
  } else if (stage === 'accounts') {
    if (typeof value.bankName !== 'string' || !Array.isArray(value.identifiers) || !strings(value.issues)
      || value.identifiers.some((x: any) => !['account', 'card'].includes(x.role) || typeof x.value !== 'string'
        || !strings(x.characters) || !Array.isArray(x.uncertainPositions))) throw new Error('账号读取结果不完整');
  }
}

export function decidePreflight(reading: PreflightReading, metrics: PageMetrics) {
  validateQualityResult('preflight', reading);
  const pixelBlank = metrics.darkFraction160 <= .00005 && metrics.darkFraction210 <= .0001;
  const blankConfirmed = reading.pageKind === 'blank' && pixelBlank && !metrics.hasPdfText;
  const index = ['A', 'B', 'C', 'D'].indexOf(reading.uprightCandidate);
  return { blankConfirmed, pixelBlank, hasPdfText: metrics.hasPdfText,
    clockwiseRotation: reading.pageKind === 'blank' || index < 0 ? 0 : index * 90,
    orientationUncertain: reading.pageKind !== 'blank' && index < 0 };
}
