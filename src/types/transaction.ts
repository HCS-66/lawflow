export type FlowDirection = 'IN' | 'OUT' | 'UNKNOWN'; // 资金方向: 转入 / 转出 / 待核对

export type AccountOwnerType = 
  | 'DEBTOR_MAIN'    // 被执行人本人
  | 'SPOUSE'         // 配偶账户
  | 'SOLE_CORP'      // 一人独资企业/名下公司
  | 'SUSPECT_PROXY'  // 疑似代持人/白手套
  | 'UNKNOWN';       // 未分配

export interface BankAccount {
  accountNumber: string;
  accountName: string;
  bankName: string;
  ownerType: AccountOwnerType;
  fileName: string;
  fileType: 'excel' | 'pdf' | 'csv' | 'ocr';
  totalIn: number;
  totalOut: number;
  transactionCount: number;
  startDate: string;
  endDate: string;
  startBalance: number;
  endBalance: number;
  isBalanced: boolean;
  balanceDiff: number;
  balanceAvailable?: boolean;
  parseStatus?: 'COMPLETE' | 'NEEDS_REVIEW' | 'INCOMPLETE';
  parseWarnings?: string[];
  coveredPages?: number[];
  totalPages?: number;
  balanceContinuityIssueCount?: number;
  reviewIssues?: EvidenceReviewIssue[];
  /** Stable evidence identity. Legacy records may only have fileName. */
  sourceDocumentId?: string;
  sourceContentHash?: string;
  extractionRunId?: string;
}

export type ReviewIssueStatus = 'PENDING' | 'CONFIRMED' | 'CORRECTED' | 'UNRESOLVED';
export type ReviewIssueCategory = 'PAGE_INTEGRITY' | 'BLANK_PAGE' | 'LOW_CONFIDENCE' | 'CANDIDATE_CONFLICT' | 'BALANCE_BREAK' | 'INVALID_AMOUNT' | 'INVALID_DATE' | 'INVALID_DIRECTION' | 'DATA_WARNING';

export interface EvidenceReviewIssue {
  id: string;
  category: ReviewIssueCategory;
  severity: 'REQUIRED' | 'ADVISORY';
  title: string;
  description: string;
  instructions: string[];
  pageNumber?: number;
  transactionIds: string[];
  status: ReviewIssueStatus;
  resolutionNote?: string;
  reviewedAt?: string;
}

export type TransactionEvidenceField =
  | 'accountNumber'
  | 'transactionTime'
  | 'direction'
  | 'amount'
  | 'balance'
  | 'counterpartyName'
  | 'counterpartyAccount'
  | 'summary';

export interface FieldEvidence {
  originalValue: string | number | null;
  currentValue: string | number | null;
  confidence?: number;
  origin: 'EXTRACTION' | 'AUTO_NORMALIZATION' | 'LAWYER_REVIEW';
  decision: 'ACCEPTED' | 'SUGGESTED' | 'CONFIRMED' | 'REJECTED' | 'UNRESOLVED';
  reason?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** Normalized top-left page coordinates. Values are constrained to 0..1. */
export interface SourceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  origin: 'MODEL' | 'PDF_TEXT' | 'ESTIMATED';
  confidence?: number;
}

export interface StandardTransaction {
  id: string;
  /** Versioned extraction contract: downstream analysis must not guess-edit fields. */
  recognitionPolicy?: 'EVIDENCE_ONLY_V1';
  /** Independent comparison evidence; never cleared by balance/zero-amount heuristics. */
  candidateReview?: {
    kind: 'FIELD_CONFLICT' | 'UNMATCHED_ROW' | 'AMBIGUOUS_ROW' | 'SOURCE_CHECK';
    reason?: string;
    requiredFields?: TransactionEvidenceField[];
    differences: Array<{ field: TransactionEvidenceField; selected: string | number | null; alternative: string | number | null }>;
    status: 'PENDING' | 'CONFIRMED' | 'UNRESOLVED';
    reviewedAt?: string;
  };
  accountNumber: string;
  accountName: string;
  bankName: string;
  transactionTime: string; // YYYY-MM-DD or YYYY-MM-DD HH:mm:ss
  transactionDate: string; // YYYY-MM-DD
  direction: FlowDirection;
  amount: number;
  balance: number;
  counterpartyName: string;
  counterpartyAccount?: string;
  counterpartyBank?: string;
  /** Normalized classification; the original description remains in field evidence. */
  transactionType?: string;
  summary: string; // 摘要 / 附言 / 备注
  rawSourceFile: string;
  /** Stable evidence identity and the extraction run which produced this row. */
  sourceDocumentId?: string;
  sourceContentHash?: string;
  extractionRunId?: string;
  sourceObservationId?: string;
  fieldEvidence?: Partial<Record<TransactionEvidenceField, FieldEvidence>>;
  rawPageNumber?: number; // 对应原始 PDF 或 Excel 行数
  rawRowIndex?: number;
  rawText?: string;
  /** Location of the printed source row on the original page. */
  sourceRegion?: SourceRegion;
  balanceAvailable?: boolean;
  extractionMethod?: 'DOCUMENT_PDF' | 'DOCUMENT_IMAGE' | 'GEMINI_DIRECT_PDF' | 'MINERU_DIRECT_PDF' | 'MANUAL';
  extractionConfidence?: number;
  extractionChunkId?: string;
  reviewStatus?: 'AUTO_PASSED' | 'PENDING' | 'VERIFIED' | 'CORRECTED';
  dataQualityIssues?: Array<'INVALID_DATE' | 'INVALID_AMOUNT' | 'UNKNOWN_DIRECTION'>;
  originalAmount?: number;
  originalBalance?: number;
  originalDirection?: FlowDirection;
  correctionReason?: string;
  reviewedBy?: string;
  reviewedAt?: string;

  // Computed & Annotated attributes
  isInternalTransfer?: boolean; // 是否属于内部自有账户互转
  internalTransferPairId?: string; // 对应的对冲交易 ID
  internalTransferMatchConfidence?: 'HIGH' | 'MEDIUM';
  internalTransferMatchReason?: string;
  /** Derived analysis linkage. Source observations remain stored even when one event is counted once. */
  analysisEventId?: string;
  duplicateOfTransactionId?: string;
  excludedFromAnalysis?: boolean;
  timePhaseTag?: string; // e.g. "执行立案后", "报告财产令送达后", "生效至立案前"
  counterpartyRoleTag?: string; // 律师后标注身份: "被执行人胞弟", "空壳过账公司"
  lawyerNote?: string; // 律师批注
}

export interface CounterpartySummary {
  identityKey?: string;
  aliases?: string[];
  transactionIds?: string[];
  name: string;
  account?: string;
  totalIn: number; // 转入总额
  totalOut: number; // 转出总额
  netOut: number; // 净流出额 (转出 - 转入)
  transactionCount: number;
  earliestDate: string;
  latestDate: string;
  frequentSummaries: string[];
  roleTag?: string; // 律师手工标注角色
  isSuspectedRelative?: boolean;
  isSuspectedAffiliate?: boolean;
}
