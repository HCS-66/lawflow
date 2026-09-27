import { FlowDirection } from './transaction';
import type { FlowCategoryCode } from '../engine/flowClassification';

export interface AnalysisAccountEntity {
  id: string;
  kind: 'ACCOUNT';
  accountNumber: string;
  accountName: string;
  bankName: string;
  sourceDocumentIds: string[];
  sourceAccountKeys: string[];
  transactionIds: string[];
}

export interface AnalysisTransactionEntity {
  id: string;
  kind: 'TRANSACTION';
  transactionId: string;
  observationIds: string[];
  accountEntityId: string;
  direction: FlowDirection;
  amount: number;
  transactionTime: string;
  isInternalTransfer: boolean;
}

export interface AnalysisCounterpartyEntity {
  id: string;
  kind: 'COUNTERPARTY';
  name: string;
  aliases?: string[];
  account?: string;
  transactionIds: string[];
  incomingTransactionIds: string[];
  outgoingTransactionIds: string[];
}

export interface JudicialDeductionEntity {
  id: string;
  kind: 'JUDICIAL_DEDUCTION';
  transactionId: string;
  accountEntityId: string;
  authorityEntityId: string;
  amount: number;
  transactionTime: string;
  summary: string;
}

export interface AnalysisFlowCategoryEntity {
  id: string;
  kind: 'FLOW_CATEGORY';
  code: FlowCategoryCode;
  label: string;
  direction: 'IN' | 'OUT';
  color: string;
  priority: number;
  totalAmount: number;
  transactionIds: string[];
}

export interface AnalysisDuplicateGroup {
  eventId: string;
  representativeTransactionId: string;
  observationIds: string[];
  sourceDocumentIds: string[];
  confidence: number;
  reasons: string[];
}

export type AnalysisRelationshipType =
  | 'ACCOUNT_HAS_TRANSACTION'
  | 'TRANSACTION_WITH_COUNTERPARTY'
  | 'INTERNAL_TRANSFER_PAIR'
  | 'JUDICIAL_DEDUCTION_FROM_ACCOUNT'
  | 'JUDICIAL_DEDUCTION_TO_AUTHORITY'
  | 'TRANSACTION_CLASSIFIED_AS';

export interface AnalysisRelationship {
  id: string;
  type: AnalysisRelationshipType;
  fromEntityId: string;
  toEntityId: string;
  transactionIds: string[];
  amount: number;
}

export interface CaseAnalysisGraph {
  accounts: AnalysisAccountEntity[];
  transactions: AnalysisTransactionEntity[];
  counterparties: AnalysisCounterpartyEntity[];
  judicialDeductions: JudicialDeductionEntity[];
  flowCategories: AnalysisFlowCategoryEntity[];
  duplicateGroups: AnalysisDuplicateGroup[];
  relationships: AnalysisRelationship[];
}
