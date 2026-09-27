import { AnalysisAccountEntity, AnalysisCounterpartyEntity, CaseAnalysisGraph } from '../types/analysis';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { accountIdentityKey, isReliableAccountNumber, normalizeAccountIdentityPart, transactionBelongsToAccount } from '../utils/accountIdentity';
import { sourceIdentity } from '../utils/evidenceProvenance';
import { effectiveCounterpartyName, isJudicialDeduction } from './bilateral';
import { classifyTransactionFlow } from './flowClassification';
import { CanonicalTransactionEvent } from './transactionEvents';
import { businessAccounts } from '../review/recognitionCompleteness';
import { counterpartyIdentityKey } from './counterpartyIdentity';

function entityKey(prefix: string, value: string): string {
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 16777619);
    right ^= code + index;
    right = Math.imul(right, 3266489909);
  }
  return `${prefix}_${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

function masterAccountKey(value: Pick<BankAccount, 'accountNumber' | 'bankName' | 'fileName' | 'sourceDocumentId'>): string {
  if (isReliableAccountNumber(value.accountNumber)) return `account|${normalizeAccountIdentityPart(value.accountNumber)}`;
  return `unverified|${accountIdentityKey(value)}`;
}

export function buildCaseAnalysisGraph(
  accounts: BankAccount[],
  transactions: StandardTransaction[],
  events: CanonicalTransactionEvent[] = []
): CaseAnalysisGraph {
  const accountEntitiesByKey = new Map<string, AnalysisAccountEntity>();
  for (const account of businessAccounts(accounts)) {
    const masterKey = masterAccountKey(account);
    const sourceAccountKey = accountIdentityKey(account);
    const existing = accountEntitiesByKey.get(masterKey);
    if (existing) {
      existing.sourceDocumentIds = unique([...existing.sourceDocumentIds, sourceIdentity(account)]);
      existing.sourceAccountKeys = unique([...existing.sourceAccountKeys, sourceAccountKey]);
      if (!existing.accountName && account.accountName) existing.accountName = account.accountName;
      if (!existing.bankName && account.bankName) existing.bankName = account.bankName;
      continue;
    }
    const entity: AnalysisAccountEntity = {
      id: entityKey('account', masterKey),
      kind: 'ACCOUNT',
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      bankName: account.bankName,
      sourceDocumentIds: [sourceIdentity(account)],
      sourceAccountKeys: [sourceAccountKey],
      transactionIds: []
    };
    accountEntitiesByKey.set(masterKey, entity);
  }

  const accountIdByTransaction = new Map<string, string>();
  for (const transaction of transactions) {
    const sourceAccount = accounts.find(account => transactionBelongsToAccount(transaction, account));
    const transactionLikeAccount = {
      accountNumber: transaction.accountNumber,
      bankName: transaction.bankName,
      fileName: transaction.rawSourceFile,
      sourceDocumentId: transaction.sourceDocumentId
    };
    const masterKey = masterAccountKey(sourceAccount || transactionLikeAccount);
    let entity = accountEntitiesByKey.get(masterKey);
    if (!entity) {
      entity = {
        id: entityKey('account', masterKey),
        kind: 'ACCOUNT',
        accountNumber: transaction.accountNumber,
        accountName: transaction.accountName,
        bankName: transaction.bankName,
        sourceDocumentIds: [sourceIdentity(transaction)],
        sourceAccountKeys: [accountIdentityKey(transaction)],
        transactionIds: []
      };
      accountEntitiesByKey.set(masterKey, entity);
    }
    accountIdByTransaction.set(transaction.id, entity.id);
    entity.transactionIds.push(transaction.id);
  }
  const accountEntities = [...accountEntitiesByKey.values()];

  const eventByRepresentativeId = new Map(events.map(event => [event.representative.id, event]));
  const transactionEntityIdByTransactionId = new Map<string, string>();
  for (const transaction of transactions) {
    transactionEntityIdByTransactionId.set(transaction.id, transaction.analysisEventId || `transaction_${transaction.id}`);
  }

  const counterparties = new Map<string, AnalysisCounterpartyEntity>();
  for (const transaction of transactions.filter(item => !item.isInternalTransfer)) {
    const name = effectiveCounterpartyName(transaction);
    const key = counterpartyIdentityKey(transaction, name);
    const id = entityKey('counterparty', key);
    const entity = counterparties.get(id) || {
      id, kind: 'COUNTERPARTY' as const, name, account: transaction.counterpartyAccount,
      transactionIds: [], incomingTransactionIds: [], outgoingTransactionIds: []
    };
    entity.aliases = unique([...(entity.aliases || []), name]);
    entity.transactionIds.push(transaction.id);
    if (transaction.direction === 'IN') entity.incomingTransactionIds.push(transaction.id);
    if (transaction.direction === 'OUT') entity.outgoingTransactionIds.push(transaction.id);
    counterparties.set(id, entity);
  }

  const relationships: CaseAnalysisGraph['relationships'] = [];
  const flowCategories = new Map<string, CaseAnalysisGraph['flowCategories'][number]>();
  for (const transaction of transactions) {
    const transactionEntityId = transactionEntityIdByTransactionId.get(transaction.id)!;
    const accountEntityId = accountIdByTransaction.get(transaction.id)!;
    relationships.push({ id: `account_tx_${transaction.id}`, type: 'ACCOUNT_HAS_TRANSACTION', fromEntityId: accountEntityId, toEntityId: transactionEntityId, transactionIds: [transaction.id], amount: transaction.amount });
    if (!transaction.isInternalTransfer) {
      const counterpartyName = effectiveCounterpartyName(transaction);
      const counterpartyId = entityKey('counterparty', counterpartyIdentityKey(transaction, counterpartyName));
      relationships.push({ id: `tx_counterparty_${transaction.id}`, type: 'TRANSACTION_WITH_COUNTERPARTY', fromEntityId: transactionEntityId, toEntityId: counterpartyId, transactionIds: [transaction.id], amount: transaction.amount });
    }
    const classification = classifyTransactionFlow(transaction);
    if (classification) {
      const categoryId = `flow_category_${classification.code}`;
      const category = flowCategories.get(categoryId) || { id: categoryId, kind: 'FLOW_CATEGORY' as const, ...classification, totalAmount: 0, transactionIds: [] };
      category.totalAmount += transaction.amount;
      category.transactionIds.push(transaction.id);
      flowCategories.set(categoryId, category);
      relationships.push({ id: `tx_flow_category_${transaction.id}`, type: 'TRANSACTION_CLASSIFIED_AS', fromEntityId: transactionEntityId, toEntityId: categoryId, transactionIds: [transaction.id], amount: transaction.amount });
    }
    if (transaction.internalTransferPairId && transaction.id < transaction.internalTransferPairId) {
      relationships.push({
        id: `internal_${transaction.id}_${transaction.internalTransferPairId}`,
        type: 'INTERNAL_TRANSFER_PAIR',
        fromEntityId: transactionEntityId,
        toEntityId: transactionEntityIdByTransactionId.get(transaction.internalTransferPairId) || `transaction_${transaction.internalTransferPairId}`,
        transactionIds: [transaction.id, transaction.internalTransferPairId],
        amount: transaction.amount
      });
    }
  }

  const judicialDeductions = transactions.filter(isJudicialDeduction).map(transaction => {
    const accountEntityId = accountIdByTransaction.get(transaction.id)!;
    const authorityName = effectiveCounterpartyName(transaction);
    const authorityEntityId = entityKey('counterparty', counterpartyIdentityKey(transaction, authorityName));
    const id = `judicial_${transaction.id}`;
    relationships.push({ id: `${id}_account`, type: 'JUDICIAL_DEDUCTION_FROM_ACCOUNT', fromEntityId: accountEntityId, toEntityId: id, transactionIds: [transaction.id], amount: transaction.amount });
    relationships.push({ id: `${id}_authority`, type: 'JUDICIAL_DEDUCTION_TO_AUTHORITY', fromEntityId: id, toEntityId: authorityEntityId, transactionIds: [transaction.id], amount: transaction.amount });
    return { id, kind: 'JUDICIAL_DEDUCTION' as const, transactionId: transaction.id, accountEntityId, authorityEntityId, amount: transaction.amount, transactionTime: transaction.transactionTime, summary: transaction.summary };
  });

  return {
    accounts: accountEntities,
    transactions: transactions.map(transaction => {
      const event = eventByRepresentativeId.get(transaction.id);
      return {
        id: transactionEntityIdByTransactionId.get(transaction.id)!,
        kind: 'TRANSACTION' as const,
        transactionId: transaction.id,
        observationIds: event?.observations.map(item => item.id) || [transaction.id],
        accountEntityId: accountIdByTransaction.get(transaction.id)!,
        direction: transaction.direction,
        amount: transaction.amount,
        transactionTime: transaction.transactionTime,
        isInternalTransfer: Boolean(transaction.isInternalTransfer)
      };
    }),
    counterparties: [...counterparties.values()],
    judicialDeductions,
    flowCategories: [...flowCategories.values()].sort((left, right) => left.direction.localeCompare(right.direction) || right.priority - left.priority || right.totalAmount - left.totalAmount),
    duplicateGroups: events.filter(event => event.observations.length > 1).map(event => ({
      eventId: event.id,
      representativeTransactionId: event.representative.id,
      observationIds: event.observations.map(item => item.id),
      sourceDocumentIds: unique(event.observations.map(sourceIdentity)),
      confidence: event.confidence,
      reasons: event.reasons
    })),
    relationships
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
