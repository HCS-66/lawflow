import { accountFromSource, bankFromSource, moneyFromSource, STATEMENT_COLUMNS, type AssemblyIssue, type SourceRegistry } from './sourceAssembly';
import { materializeTableMapping, type TableMappingPlan } from './tableMapping';
import { compareIndependentReadings, type IndependentPage } from './independentComparison';
import { consolidateObservations } from './observationConsolidation';
import { applyFocusedAccountRecovery, type FocusedAccounts } from './accountRecovery';
import { assessAccountInventory } from './accountInventoryBinding';
import { findUnmergedViewOverlaps } from './unmergedViews';
import { recoverPrintedOwnerPrefixes } from './printedOwnerPrefixes';
import { semanticText } from './semanticText';
import { collectAccountIssuers } from './accountIssuerEvidence';
import { recoverSignedIncome } from './signedAmountDirection';
import { printedTransactionType } from './printedTransactionType';
import { applyCriticalFieldRecovery } from './criticalFieldRecovery';
import { auxiliaryPrintedPurpose } from './auxiliaryPurpose';

/** Shared web/replay pipeline; document scope is explicit, never inferred from an account prefix. */
export function runQualityTrial(mapping: TableMappingPlan, registry: SourceRegistry,
  originalIndependent: Record<number, IndependentPage>, options: { singleIssuerDocument: boolean; issuerBankName?: string }, accountRecovery: Record<number, FocusedAccounts> = {},
  criticalRereads: Record<number, IndependentPage> = {}) {
  const materialized = materializeTableMapping(mapping, registry);
  const rows = structuredClone(materialized.rows);
  const criticalRecovery = applyCriticalFieldRecovery(rows, registry, originalIndependent, criticalRereads);
  const recovery = applyFocusedAccountRecovery(rows, materialized.metadata, registry, criticalRecovery.pages, accountRecovery);
  const independent = recovery.pages;
  const transformations: Array<{ observation: number; field: number; before: string; after: string; basis: string; sources: string[] }> = [];
  const typeUncertainties: number[] = [];
  const change = (i: number, field: number, value: string, basis: string, sources: string[]) => {
    if (rows[i].values[field] === value) return;
    transformations.push({ observation: i + 1, field, before: rows[i].values[field], after: value, basis, sources });
    rows[i].values[field] = value;
  };
  const recoveredOwnerPrefixes = recoverPrintedOwnerPrefixes(rows, materialized.metadata, registry, independent);
  for (const recovered of recoveredOwnerPrefixes) {
    const original = rows[recovered.observation - 1].values[0], page = materialized.metadata[recovered.observation - 1].page;
    for (const alternate of independent[page]?.rows || []) if (accountFromSource(alternate.values[0]) === original) alternate.values[0] = recovered.value;
    change(recovered.observation - 1, 0, recovered.value, 'PRINTED_FULL_HEADER_AND_SEPARATE_ACCOUNT_CONFIRM_CLIPPED_OWNER_COLUMN', recovered.sources);
  }
  rows.forEach((row, i) => {
    if (row.values[5]) return;
    const signed = row.fields[6].filter(s => /^[+-]/.test(s.text.trim()) && moneyFromSource(s.text) !== null);
    if (!signed.length || new Set(signed.map(s => s.text.trim()[0])).size !== 1) return;
    change(i, 5, signed[0].text.trim()[0] === '-' ? 'OUT' : 'IN', 'EXPLICIT_SIGN_ON_TRANSACTION_AMOUNT', signed.map(s => `cell:${s.id}`));
    row.fields[5] = signed;
  });
  for (const i of recoverSignedIncome(rows, mapping, registry, independent)) {
    change(i, 5, 'IN', 'SIGNED_DEPOSIT_COLUMN_WITH_INDEPENDENT_INCOME', rows[i].fields[6].map(s => `cell:${s.id}`));
    rows[i].fields[5] = rows[i].fields[6].map(s => ({ ...s, normalized: 'IN' }));
  }
  for (const table of mapping.tables) {
    const headers = table.ignored.filter(item => item.kind === 'header').flatMap(item => item.r).map(id => registry.rows[id]);
    const columns = new Set(headers.flatMap(header => header.cells.flatMap((id, col) =>
      /^(?:查询卡号|本方账号|客户账号|客户账户|客户帐号|卡号|账号)$/.test(registry.cells[id].text.replace(/\s/g, '')) ? [col] : [])));
    if (columns.size !== 1) continue;
    const col = [...columns][0];
    const cells = table.groups.flatMap(group => {
      const cell = registry.cells[registry.rows[group[0]].cells[col]], value = cell ? accountFromSource(cell.text) : null;
      return cell && value && /^\d{8,32}$/.test(value) ? [{ cell, value }] : [];
    });
    const values = new Set(cells.map(item => item.value));
    const altAccounts = new Set((independent[table.page]?.rows || []).map(row => accountFromSource(row.values[0])).filter(Boolean));
    rows.forEach((row, i) => {
      if (row.values[0] || materialized.metadata[i].page !== table.page || materialized.metadata[i].table !== table.table) return;
      const ownCell = registry.cells[registry.rows[row.sourceRows[0]].cells[col]];
      const direct = ownCell && accountFromSource(ownCell.text);
      const selected = direct && /^\d{8,32}$/.test(direct) ? { cell: ownCell, value: direct }
        : values.size === 1 && altAccounts.size === 1 && altAccounts.has(cells[0]?.value) ? cells[0] : undefined;
      if (!selected) return;
      change(i, 0, selected.value, direct ? 'EXPLICIT_OWNER_ACCOUNT_COLUMN' : 'SINGLE_PRINTED_ACCOUNT_WITH_INDEPENDENT_TABLE_SUPPORT', [`cell:${selected.cell.id}`]);
      row.fields[0] = [{ id: selected.cell.id, text: selected.cell.text, normalized: selected.value }];
    });
  }
  const rejectedIssuerEvidence: Array<{ page: number; bank: string; basis: string }> = [];
  const issuerEvidence = Object.entries(independent).filter(([, p]) => p.bankName?.trim())
    .map(([page, p]) => ({ page, bank: bankFromSource(p.bankName!) })).filter(item => {
      const focused = accountRecovery[Number(item.page)];
      const printed = Object.values(registry.cells).filter(c => c.page === Number(item.page) && /银行/.test(c.text));
      // A scoped reread and the full primary transcription must both lack the
      // alleged issuer. Do not let one ungrounded metadata value rewrite the document.
      if (focused && focused.bankName === '' && !focused.issues.length && !printed.length) {
        rejectedIssuerEvidence.push({ page: Number(item.page), bank: item.bank,
          basis: 'NO_PRINTED_BANK_NAME_IN_PRIMARY_PAGE_OR_SEPARATE_FULL_PAGE_ISSUER_READING' });
        return false;
      }
      return true;
    });
  const issuerValues = new Set(issuerEvidence.map(e => e.bank).filter(bank => !/^(?:商业银行|商业银行股份有限公司)$/.test(bank)));
  const suppliedIssuer = options.issuerBankName ? bankFromSource(options.issuerBankName) : '';
  const issuerConflict = Boolean(suppliedIssuer && [...issuerValues].some(value => value !== suppliedIssuer));
  const issuer = options.singleIssuerDocument && !issuerConflict
    ? suppliedIssuer || (issuerValues.size === 1 ? [...issuerValues][0] : '') : '';
  const issuerSources = [...issuerEvidence.map(e => `independent:p${e.page}:issuer`), ...(suppliedIssuer ? ['input:bankDocumentInventory'] : [])];
  const accountInventory = assessAccountInventory(rows, mapping, registry, independent, accountRecovery);
  const accountBindings = accountInventory.bindings;
  for (const binding of accountBindings) {
    const pages = new Set(binding.observations.flatMap(n => rows[n - 1].sourceRows.map(id => registry.rows[id].page)));
    for (const n of binding.observations) change(n - 1, 0, binding.to, 'ACCOUNT_LIST_AND_END_BALANCE_CONFIRM_PRINTED_LOCAL_ACCOUNT', binding.sources);
    for (const page of pages) for (const row of independent[page]?.rows || []) {
      if (accountFromSource(row.values[0]) === binding.from) row.values[0] = binding.to;
    }
  }
  const inventory = new Map<string, string[]>();
  const accountIssuers = collectAccountIssuers(registry, independent);
  for (const [page, reading] of Object.entries(independent)) if (['account_info', 'document'].includes(reading.pageType)) {
    for (const identifier of reading.ownerIdentifiers || []) if (identifier.role === 'account' && /^\d{8,32}$/.test(identifier.value)) {
      inventory.set(identifier.value, [...(inventory.get(identifier.value) || []), `independent:p${page}:ownerAccount`]);
    }
  }
  const conversionRows = new Set<number>();
  const conversionInterestRows = new Set<number>();
  const loanAccounts = new Set(rows.flatMap((row, i) => row.values[5] === 'IN' && row.values[10]
    && /^(?:放款|贷款放款|个人贷款发放)(?:$|--|[：:])/.test(materialized.metadata[i].description)
    ? [JSON.stringify([row.values[0], row.values[10]])] : []));
  rows.forEach((row, i) => {
    const next = rows[i + 1], fee = rows[i + 2];
    if (!next || !fee || !/^(?:普通消费转分期|账单分期)$/.test(materialized.metadata[i].description)
      || materialized.metadata[i + 1].description !== '消费'
      || !/^(?:费用|消费[（(]利息[）)])$/.test(materialized.metadata[i + 2].description)) return;
    if (materialized.metadata[i].accountKind !== 'credit' || ![next, fee].every(other => other.values[0] === row.values[0]
      && other.values[4] === row.values[4]) || row.values[5] !== 'IN' || next.values[5] !== 'OUT'
      || fee.values[5] !== 'OUT') return;
    conversionRows.add(i); conversionRows.add(i + 1);
    if (/^消费[（(]利息[）)]$/.test(materialized.metadata[i + 2].description)) conversionInterestRows.add(i + 2);
  });
  const names = new Map<string, Map<string, number[]>>();
  const combinedCounterpartyTables = new Set<string>();
  for (const table of mapping.tables) {
    const selector = table.fields.counterpartyName;
    if (!selector || !('row' in selector) || table.fields.counterpartyAccount) continue;
    const labels = table.ignored.filter(item => item.kind === 'header').flatMap(item => item.r)
      .map(id => registry.cells[registry.rows[id].cells[selector.col - 1]]?.text.replace(/\s/g, ''));
    if (!labels.includes('对方信息')) continue;
    const values = table.groups.map(group => registry.cells[registry.rows[group[selector.row]]?.cells[selector.col - 1]]?.text.trim() || '').filter(Boolean);
    if (values.length >= 3 && values.every(value => /^[^\d]+\d{4}$/.test(value))) combinedCounterpartyTables.add(`${table.page}:${table.table}`);
  }
  rows.forEach((row, i) => {
    if (!row.values[0] || !row.values[1]) return;
    const variants = names.get(row.values[0]) || new Map<string, number[]>();
    variants.set(row.values[1], [...(variants.get(row.values[1]) || []), i]); names.set(row.values[0], variants);
  });
  rows.forEach((row, i) => {
    const context = materialized.metadata[i];
    if ((!row.values[2] || /^(?:商业银行|商业银行股份有限公司)$/.test(row.values[2])) && issuer) change(i, 2, issuer, 'EXPLICIT_ISSUER_WITH_SINGLE_BANK_DOCUMENT_SCOPE', issuerSources);
    const exactIssuers = accountIssuers.get(row.values[0]);
    if ((!row.values[2] || /^(?:商业银行|商业银行股份有限公司)$/.test(row.values[2])) && exactIssuers?.size === 1) {
      const [bank, sources] = [...exactIssuers][0];
      change(i, 2, bank, 'EXACT_ACCOUNT_WITH_PRINTED_AND_INDEPENDENT_ISSUER', sources);
    }
    const ownerNames = names.get(row.values[0]);
    if (!row.values[1] && ownerNames?.size === 1) change(i, 1, [...ownerNames.keys()][0], 'UNIQUE_NAME_FOR_EXACT_ACCOUNT', [...ownerNames.values()][0].map(n => `observation:${n + 1}:accountName`));
    const description = context.description;
    // Explicit descriptions have stable business meanings; optional model dictionaries cannot remove them.
    const printedTypes: Record<string, string> = { '费用': '手续费', '手续费': '手续费', '卡年费': '手续费', '小额费': '手续费',
      '汇费': '手续费', '短信服务': '手续费', '短信服务费': '手续费', '自动还款': '信用卡还款', '人民币自动转帐还款': '信用卡还款', '年费减免': '费用减免',
      '减免年费': '费用减免', '违约金': '违约金', '透支利息': '透支利息', '退款': '退款', '缴费': '缴费',
      '分期付款退货': '分期退款', '网络查控系统司法扣划': '司法扣划', '法院扣划': '司法扣划', '司法扣划': '司法扣划',
      '法院网络扣划': '司法扣划', '强制扣划': '司法扣划', '扣划': '司法扣划' };
    if (printedTypes[description]) change(i, 8, printedTypes[description], 'EXPLICIT_DESCRIPTION_DICTIONARY_V1', row.fields[8].map(s => `cell:${s.id}`));
    if (context.accountKind === 'deposit' && /^(?:利息|结息|支付利息|利息收入|入息)$/.test(description)) change(i, 8, '存款结息', 'PRINTED_DEPOSIT_INTEREST', row.fields[8].map(s => `cell:${s.id}`));
    if (context.accountKind === 'deposit' && description === '快捷支付') change(i, 8, '第三方支付', 'PRINTED_DEPOSIT_QUICK_PAYMENT', row.fields[8].map(s => `cell:${s.id}`));
    if (row.values[5] === 'IN' && /^(?:放款|贷款放款|个人贷款发放)(?:$|--|[：:])/.test(description)) change(i, 8, '贷款放款', 'PRINTED_LOAN_DISBURSEMENT_PREFIX', row.fields[8].map(s => `cell:${s.id}`));
    if (row.values[5] === 'OUT' && (/^还贷(?:$|[-—：:])/.test(description) || /^[A-Z0-9]+\s*还贷[-—]$/.test(description)
      || /^批处理归还欠款[-—]/.test(description) && (loanAccounts.has(JSON.stringify([row.values[0], row.values[10]])) || /贷款利息/.test(row.values[9])))) {
      change(i, 8, '贷款还款', 'PRINTED_LOAN_REPAYMENT_DESCRIPTION_WITH_ACCOUNT_CONTEXT', row.fields[8].map(s => `cell:${s.id}`));
    }
    if (/个人贷款结息/.test(description) && row.values[5] === 'OUT') change(i, 8, '贷款还款', 'PRINTED_LOAN_INTEREST_PAYMENT', row.fields[8].map(s => `cell:${s.id}`));
    if (row.values[5] === 'OUT' && /保险(?:股份)?有限公司/.test(semanticText(row.values[9]))) change(i, 8, '保险支出', 'PRINTED_INSURER_COUNTERPARTY', row.fields[9].map(s => `cell:${s.id}`));
    if (description === '个人贷款' && ['IN', 'OUT'].includes(row.values[5])) change(i, 8, row.values[5] === 'IN' ? '贷款放款' : '贷款还款', 'PRINTED_LOAN_WITH_DIRECTION', row.fields[8].map(s => `cell:${s.id}`));
    if (/^(?:账单分期|普通消费转分期)$/.test(description)) change(i, 8, '分期转换', 'PRINTED_INSTALLMENT_CONVERSION', row.fields[8].map(s => `cell:${s.id}`));
    if (/^分期付款(?:到期扣收|利息)/.test(description)) change(i, 8, '分期', 'PRINTED_INSTALLMENT_PAYMENT', row.fields[8].map(s => `cell:${s.id}`));
    if (/消费/.test(description) && !/转分期|利息/.test(description)) change(i, 8, '消费', 'PRINTED_PURCHASE', row.fields[8].map(s => `cell:${s.id}`));
    if (conversionRows.has(i)) change(i, 8, '分期转换', 'MATCHED_PRINTED_INSTALLMENT_CONVERSION_SEQUENCE', rows.slice(Math.max(0, i - 1), i + 2).flatMap(r => r.fields[8].map(s => `cell:${s.id}`)));
    if (conversionInterestRows.has(i)) change(i, 8, '分期', 'INTEREST_IN_PRINTED_INSTALLMENT_CONVERSION_SEQUENCE', rows.slice(i - 2, i + 1).flatMap(r => r.fields[8].map(s => `cell:${s.id}`)));
    const purposeFields = [...row.fields[8], ...row.fields[9]];
    const printedType = printedTransactionType(description, purposeFields.map(s => s.text), row.values[5], context.accountKind);
    if (printedType && !(printedType.requiresReview && !printedType.type && row.values[8])) {
      change(i, 8, printedType.type, printedType.basis, purposeFields.map(s => `cell:${s.id}`));
    }
    if (printedType?.requiresReview) typeUncertainties.push(i);
    const table = mapping.tables.find(t => t.page === context.page && t.table === context.table)!;
    const auxiliaryPurpose = printedType?.requiresReview ? null : auxiliaryPrintedPurpose(row, table, registry);
    if (auxiliaryPurpose) {
      const { cell, type } = auxiliaryPurpose;
      change(i, 8, type, 'LITERAL_BUSINESS_LABEL_IN_AUXILIARY_COLUMN_WITH_MATCHING_DIRECTION', [`cell:${cell.id}`]);
      row.fields[8].push({ id: cell.id, text: cell.text, normalized: cell.text });
    }
    if (['消费', '退款', '缴费'].includes(row.values[8])) {
      const headers = table.ignored.filter(s => s.kind === 'header').flatMap(s => s.r).map(id => registry.rows[id]);
      const merchantColumns = new Set(headers.flatMap(r => r.cells.flatMap((id, col) =>
        /^(?:交易场所简称|商户名称|商户简称|交易商户)$/.test(registry.cells[id].text.replace(/\s/g, '')) ? [col] : [])));
      const merchantSelector = table.fields.merchantName;
      const selectedRow = merchantSelector && 'row' in merchantSelector ? merchantSelector.row : 0;
      const selectedColumn = merchantSelector && 'row' in merchantSelector ? merchantSelector.col - 1
        : merchantColumns.size === 1 ? [...merchantColumns][0] : null;
      if (selectedColumn !== null) {
        const sourceRow = registry.rows[row.sourceRows[selectedRow]];
        const cell = sourceRow ? registry.cells[sourceRow.cells[selectedColumn]] : undefined;
        if (cell?.text.trim()) {
          change(i, 9, cell.text.trim(), 'PRINTED_MERCHANT_COLUMN_FOR_PURCHASE', [`cell:${cell.id}`]);
          row.fields[9] = [{ id: cell.id, text: cell.text, normalized: cell.text.trim() }];
        }
      }
    }
    const internalInterestName = /^(?:银行卡)?存款应(?:计)?付利息0*$/.test(semanticText(row.values[9]));
    if (combinedCounterpartyTables.has(`${context.page}:${context.table}`) && !internalInterestName && !row.values[10]) {
      const combined = row.values[9].match(/^([^\d]+)(\d{4})$/);
      if (combined) {
        const sources = row.fields[9].map(s => `cell:${s.id}`);
        change(i, 10, `尾号${combined[2]}`, 'CONSISTENT_COMBINED_COUNTERPARTY_NAME_AND_SUFFIX_COLUMN', sources);
        change(i, 9, combined[1], 'CONSISTENT_COMBINED_COUNTERPARTY_NAME_AND_SUFFIX_COLUMN', sources);
      }
    }
    const service = ['存款结息', '手续费', '分期', '分期转换', '费用减免', '违约金', '透支利息'].includes(row.values[8]);
    if (service && (!row.values[10] || row.values[10] === row.values[0]) && (!row.values[9] || internalInterestName || /^(?:其他|分行营业室|汇总分期|\d+\/\d+\s.*)$/.test(row.values[9])) && row.values[2]) {
      const serviceSources = [...row.fields[2].map(c => `cell:${c.id}`), ...(exactIssuers?.get(row.values[2]) || []),
        ...(issuer === row.values[2] ? issuerSources : [])];
      change(i, 9, row.values[2], 'ISSUER_AS_SERVICE_COUNTERPARTY_WITH_NO_OTHER_PRINTED_PARTY', serviceSources);
      if (row.values[8] !== '存款结息' && !row.values[11]) change(i, 11, row.values[2], 'ISSUER_AS_SERVICE_COUNTERPARTY_BANK', serviceSources);
    }
  });
  const codeMaps = Object.fromEntries(mapping.tables.map(t => [`${t.page}:${t.table}`, t.directionCodes || {}]));
  const singleAccounts: Record<string, string> = {};
  for (const table of mapping.tables) {
    const headers = table.ignored.filter(item => item.kind === 'header').flatMap(item => item.r).map(id => registry.rows[id]);
    const columns = new Set(headers.flatMap(header => header.cells.flatMap((id, col) =>
      /^(?:查询卡号|本方账号|客户账号|客户账户|客户帐号|卡号|账号)$/.test(registry.cells[id].text.replace(/\s/g, '')) ? [col] : [])));
    if (columns.size !== 1 || !table.groups.length) continue;
    const column = [...columns][0];
    const accountValues = table.groups.map(group => accountFromSource(registry.cells[registry.rows[group[0]].cells[column]]?.text || ''));
    const unique = new Set(accountValues.filter((v): v is string => Boolean(v)));
    if (unique.size === 1 && accountValues.every(v => v !== null) && /^\d{8,32}$/.test([...unique][0])) {
      singleAccounts[`${table.page}:${table.table}`] = [...unique][0];
    }
  }
  const contextualDirections: Record<number, string> = {};
  const accountGroups = new Map<string, number[]>();
  rows.forEach((row, i) => accountGroups.set(row.values[0], [...(accountGroups.get(row.values[0]) || []), i]));
  for (const indices of accountGroups.values()) {
    const orderKey = (i: number) => rows[i].values[3] || rows[i].values[4];
    const interest = (i: number) => /^(?:利息|结息|支付利息|利息收入|入息)$/.test(materialized.metadata[i].description);
    const ordered = [...indices].sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
    if (ordered.length < 3 || !ordered.every(i => materialized.metadata[i].accountKind === 'deposit'
      && (['IN', 'OUT'].includes(rows[i].values[5]) || (!rows[i].values[5] && interest(i)))
      && /^\d+\.\d{2}$/.test(rows[i].values[6]) && /^-?\d+\.\d{2}$/.test(rows[i].values[7]))) continue;
    const cents = (value: string) => BigInt(value.replace('.', ''));
    if (!ordered.slice(1).every((i, k) => orderKey(i) > orderKey(ordered[k])
      && cents(rows[i].values[7]) - cents(rows[ordered[k]].values[7]) === cents(rows[i].values[6]) * (rows[i].values[5] === 'OUT' ? -1n : 1n))) continue;
    for (const [position, i] of ordered.entries()) {
      if (!rows[i].values[5]) change(i, 5, 'IN', 'PRINTED_DEPOSIT_INTEREST_WITH_EXACT_BALANCE_SEQUENCE', rows[i].sourceRows.map(id => `row:${id}`));
      if (position > 0 || interest(i)) contextualDirections[i + 1] = rows[i].values[5];
    }
  }
  const comparison = compareIndependentReadings(rows, registry, independent, codeMaps, singleAccounts, combinedCounterpartyTables, contextualDirections);
  const consolidation = consolidateObservations(rows, materialized.metadata,
    Object.fromEntries(comparison.pairs.map(p => [p.outputRow, p.values])));
  const eventForObservation = new Map<number, number>();
  consolidation.events.forEach((event, index) => event.observations.forEach(o => eventForObservation.set(o + 1, index + 1)));
  const pairForObservation = new Map(comparison.pairs.map(p => [p.outputRow, p]));
  const resolved: Array<{ code: string; field: string | null; event: number; observations: number[]; basis: string }> = [];
  const pending: AssemblyIssue[] = [];
  for (const i of typeUncertainties) pending.push({ id: `REPAYMENT_TYPE_${i + 1}`, code: 'REPAYMENT_KIND_UNRESOLVED',
    field: 'transactionType', severity: 'REQUIRED', outputRows: [eventForObservation.get(i + 1)!], sourceRows: rows[i].sourceRows,
    sourceCells: [...rows[i].fields[8], ...rows[i].fields[9]].map(s => s.id),
    message: '同笔原文出现还款，但未明确贷款或信用卡；已保留可读摘要类别，请确认具体用途' });
  rows.forEach((row, i) => {
    if (/^(?:银行卡)?存款应(?:计)?付利息0*$/.test(semanticText(row.values[9])) && !row.values[2]) {
      pending.push({ id: `ISSUER_PARTY_${i + 1}`, code: 'SERVICE_ISSUER_UNCONFIRMED', field: 'counterpartyName', severity: 'REQUIRED',
        outputRows: [eventForObservation.get(i + 1)!], sourceRows: row.sourceRows, sourceCells: row.fields[9].map(c => c.id),
        message: '原文为银行内部利息科目，尚未确认出具银行，不能据此认定实际交易对方' });
    }
  });
  for (const [i, conflict] of accountInventory.unresolved.entries()) {
    pending.push({ id: `ACCOUNT_INVENTORY_${i + 1}`, code: 'UNCONFIRMED_ACCOUNT_INVENTORY_BINDING', field: 'accountNumber', severity: 'REQUIRED',
      outputRows: [...new Set(conflict.observations.map(n => eventForObservation.get(n)!))], sourceRows: conflict.sourceRows, sourceCells: [],
      message: '流水中的本方账号与账户清单的完整账号存在待确认的对应关系，请确认完整账号后应用到这些交易' });
  }
  for (const [i, overlap] of findUnmergedViewOverlaps(rows, materialized.metadata, eventForObservation).entries()) {
    pending.push({ id: `UNMERGED_VIEWS_${i + 1}`, code: 'UNRESOLVED_DUPLICATE_VIEWS', field: null, severity: 'REQUIRED',
      outputRows: [...new Set(overlap.observations.map(n => eventForObservation.get(n)!))],
      sourceRows: overlap.observations.flatMap(n => rows[n - 1].sourceRows), sourceCells: [],
      message: `两种明细版式有${overlap.anchors}笔独立内容重合，尚不能完整合并；请检查重复范围` });
  }
  if (issuerConflict) pending.push({ id: 'ISSUER_CONFLICT', code: 'DOCUMENT_BANK_CONFLICT', field: 'bankName', severity: 'REQUIRED',
    outputRows: consolidation.events.map((_, i) => i + 1), sourceRows: rows.flatMap(r => r.sourceRows), sourceCells: [],
    message: '上传材料的银行归属与页面明确银行名称不一致，请确认资料归属' });
  const push = (issue: AssemblyIssue) => pending.push({ ...issue, outputRows: [...new Set(issue.outputRows.map(n => eventForObservation.get(n)!).filter(Boolean))] });
  const printedMissingCounterparty = (n: number) => {
    const row = rows[n - 1], pair = pairForObservation.get(n);
    return row.values[8] === '存款结息' && row.values[9] === row.values[2] && Boolean(row.values[2])
      && row.fields[10].some(s => /^[?？]$/.test(s.text.trim())) && Boolean(pair && /^[?？]$/.test(pair.values[10]));
  };
  const confirmedCashWithoutCounterparty = (n: number) => {
    const row = rows[n - 1], pair = pairForObservation.get(n);
    if (!['现金存入', '现金支取'].includes(row.values[8]) || row.values[9] || row.values[10] || !pair
      || pair.values[9] || pair.values[10]) return false;
    const other = independent[pair.page]?.rows.find(r => r.row === pair.independentRow);
    if (!other || other.issues.some(i => ['counterpartyName', 'counterpartyAccount'].includes(i.field))) return false;
    // Require actual selected empty source cells, not merely a model's missing mapping.
    return [9, 10].every(f => row.fields[f].length > 0 && row.fields[f].every(s => /^(?:\s*|--?|—|无)$/.test(s.text.trim())));
  };
  for (const issue of materialized.issues) {
    if (issue.field === 'bankName' && issue.code === 'INVALID_SOURCE_FRAGMENT' && issuer && issuerValues.has(issuer)
      && issue.outputRows.every(n => rows[n - 1].values[2] === issuer)) {
      resolved.push({ code: issue.code, field: issue.field, event: eventForObservation.get(issue.outputRows[0])!, observations: issue.outputRows,
        basis: 'Invalid model fragment replaced by explicit document issuer and independently read issuer; invalid original retained' });
      continue;
    }
    if (issue.field === 'counterpartyAccount' && issue.code === 'UNREADABLE_SOURCE' && issue.outputRows.every(printedMissingCounterparty)) {
      resolved.push({ code: issue.code, field: issue.field, event: eventForObservation.get(issue.outputRows[0])!, observations: issue.outputRows,
        basis: 'Both readings show a literal question-mark placeholder for the issuer-paid deposit-interest account; no hidden digits reconstructed' });
      continue;
    }
    if (issue.code === 'MISSING_KEY_SOURCE' && issue.field === 'accountNumber' && issue.outputRows.every(n =>
      rows[n - 1].values[0] && pairForObservation.get(n)?.values[0] === rows[n - 1].values[0])) continue;
    if (issue.code === 'DIRECTION_REQUIRES_INDEPENDENT_READ' && issue.outputRows.every(n => pairForObservation.get(n)?.values[5] === rows[n - 1].values[5] && rows[n - 1].values[5])) continue;
    if (issue.code === 'COUNTERPARTY_IDENTITY_MISSING' && issue.outputRows.every(n => {
      const own = rows[n - 1].values, pair = pairForObservation.get(n);
      return own[9] || own[10];
    })) continue;
    if (issue.code === 'COUNTERPARTY_IDENTITY_MISSING' && issue.outputRows.every(confirmedCashWithoutCounterparty)) {
      resolved.push({ code: issue.code, field: issue.field, event: eventForObservation.get(issue.outputRows[0])!, observations: issue.outputRows,
        basis: 'Explicit cash transaction; selected party cells and independent reading both blank without identity uncertainty' });
      continue;
    }
    push(issue);
  }
  consolidation.events.forEach((event, eventIndex) => {
    for (const conflict of event.conflicts) {
      const chosen = event.values[conflict.field];
      const different = event.observations.filter(n => rows[n].values[conflict.field] && rows[n].values[conflict.field] !== chosen);
      const fromInventory = conflict.field === 0 && inventory.has(chosen)
        && different.every(n => !materialized.metadata[n].directOwner && !inventory.has(rows[n].values[0]))
        && event.observations.some(n => materialized.metadata[n].directOwner && rows[n].values[0] === chosen);
      const corroborated = fromInventory || different.every(n => pairForObservation.get(n + 1)?.values[conflict.field] === chosen);
      if (corroborated) resolved.push({ code: 'DUPLICATE_VIEW_CONFLICT', field: STATEMENT_COLUMNS[conflict.field], event: eventIndex + 1,
        observations: event.observations.map(n => n + 1), basis: fromInventory
          ? `Explicit account inventory and per-row account column support the selected account in established duplicate views: ${inventory.get(chosen)!.join(',')}`
          : 'Selected printed value also independently read from every disagreeing source view' });
      else pending.push({ id: `DC${eventIndex + 1}-${conflict.field}`, code: 'UNRESOLVED_DUPLICATE_VIEW_CONFLICT', field: STATEMENT_COLUMNS[conflict.field],
        outputRows: [eventIndex + 1], sourceRows: event.observations.flatMap(n => rows[n].sourceRows), sourceCells: [], severity: 'REQUIRED', message: '重复版式存在未解决的字段冲突，保留所有候选供核对' });
    }
  });
  for (const issue of comparison.issues) {
    if (issue.field === 'counterpartyAccount' && ['INDEPENDENT_VALUE_CONFLICT', 'INDEPENDENT_SOURCE_UNCERTAIN'].includes(issue.code)
      && issue.outputRows.every(printedMissingCounterparty)) {
      resolved.push({ code: issue.code, field: issue.field, event: eventForObservation.get(issue.outputRows[0])!, observations: issue.outputRows,
        basis: 'Two literal question-mark placeholders denote an account not provided by the source; issuer identity is explicit' });
      continue;
    }
    if (issue.code === 'INDEPENDENT_VALUE_CONFLICT' && issue.field && issue.outputRows.length === 1) {
      const observation = issue.outputRows[0], pair = pairForObservation.get(observation);
      const eventIndex = eventForObservation.get(observation)!;
      const event = consolidation.events[eventIndex - 1];
      const field = STATEMENT_COLUMNS.indexOf(issue.field);
      if (field === 0 && !materialized.metadata[observation - 1].directOwner && inventory.has(event.values[0])
        && !inventory.has(pair?.values[0] || '') && event.observations.some(n => materialized.metadata[n].directOwner
          && rows[n].values[0] === event.values[0] && pairForObservation.get(n + 1)?.values[0] === event.values[0])) {
        resolved.push({ code: issue.code, field: issue.field, event: eventIndex, observations: [observation],
          basis: 'Established duplicate detailed row, its independent reading and separate account inventory agree; conflicting header retained' });
        continue;
      }
      if (pair && pair.values[field] === event.values[field] && event.observations.some(n => n + 1 !== observation && rows[n].values[field] === event.values[field])) {
        resolved.push({ code: issue.code, field: issue.field, event: eventIndex, observations: [observation], basis: 'Independent original-page reading agrees with another printed duplicate view' });
        continue;
      }
      if (field === 9 && pair && (!pair.values[9] || /^[@*＊]+$/.test(pair.values[9])
        || /^(?:其他|分行营业室|汇总分期|\d+\/\d+\s.*|(?:银行卡)?存款应(?:计)?付利息0*)$/.test(pair.values[9]))
        && transformations.some(t => t.observation === observation && t.field === 9 && t.basis === 'ISSUER_AS_SERVICE_COUNTERPARTY_WITH_NO_OTHER_PRINTED_PARTY')) continue;
    }
    push(issue);
  }
  const structuralConflict = pending.some(i => ['INDEPENDENT_PAGE_INCOMPLETE', 'INDEPENDENT_ROW_UNMATCHED',
    'INDEPENDENT_EXTRA_OBSERVATION', 'UNRESOLVED_DUPLICATE_VIEWS'].includes(i.code));
  return { version: 1, scope: options, complete: materialized.complete && !structuralConflict
      && registry.pages.every(p => independent[p]?.coverage === 'complete'),
    observations: rows, metadata: materialized.metadata, transformations, comparison, consolidation, rejectedIssuerEvidence, recoveredOwnerPrefixes,
    accountRecovery: { applied: recovery.applied, skipped: recovery.skipped }, accountBindings, accountInventoryConflicts: accountInventory.unresolved,
    criticalFieldRecovery: { applied: criticalRecovery.applied },
    rows: consolidation.events.map(e => ({ id: e.id, values: e.values,
      sourceObservationIds: e.observations.flatMap(n => rows[n].sourceRows.map(r => `source:${r}`)),
      observationNumbers: e.observations.map(n => n + 1) })),
    mappingRoleCorrections: materialized.roleCorrections, mappingGroupCorrections: materialized.groupCorrections,
    mappingColumnCorrections: materialized.columnCorrections, pending, resolved };
}
