import { BankAccount, StandardTransaction } from '../types/transaction';
import { accountIdentityKey, isReliableAccountNumber, normalizeAccountIdentityPart } from './accountIdentity';
import { balanceContinuityIssues, chronologicalTransactions, isBalanceConfirmedZeroSettlement, isCreditCardStatement, isFeeWaiver } from './transactionSequence';
import { isEvidenceOnly, sameSource } from '../recognition/decisionPolicy';
import { QUALITY_EXTRACTION, summarizeQualityAccounts } from '../recognition/qualityWebAdapter';

export interface NormalizedRecognizedData {
  accounts: BankAccount[];
  transactions: StandardTransaction[];
}

export function normalizeRecognizedData(
  inputAccounts: BankAccount[], inputTransactions: StandardTransaction[]
): NormalizedRecognizedData {
  const qualityRows = inputTransactions.filter(t => t.extractionMethod === QUALITY_EXTRACTION);
  const qualityAccounts = inputAccounts.filter(a => a.qualityPipeline);
  if (qualityRows.length || qualityAccounts.length) {
    const legacy = normalizeRecognizedData(inputAccounts.filter(a => !a.qualityPipeline), inputTransactions.filter(t => t.extractionMethod !== QUALITY_EXTRACTION));
    return { accounts: [...legacy.accounts, ...summarizeQualityAccounts(qualityRows, qualityAccounts)], transactions: [...legacy.transactions, ...qualityRows] };
  }
  const aliasCandidates = inputAccounts.filter(account => isReliableAccountNumber(account.accountNumber));
  const publicAccounts = inputAccounts.map(account => ({
    ...account,
    accountNumber: canonicalStoredAccountNumber(account.accountNumber, account.fileName, account.sourceDocumentId, aliasCandidates),
    parseWarnings: account.parseWarnings?.map(publicParserWarning)
  }));
  const protectedTransactions = inputTransactions.filter(isEvidenceOnly).map(transaction => structuredClone(transaction));
  const preparedTransactions = restoreUnsupportedBalanceCorrections(inputTransactions.filter(transaction => !isEvidenceOnly(transaction)).map(transaction => upgradeLegacyGeminiReviewStatus({
    ...transaction,
    accountNumber: canonicalStoredAccountNumber(transaction.accountNumber, transaction.rawSourceFile, transaction.sourceDocumentId, aliasCandidates)
  })));
  const stabilized = repairOutlierOcrYears(restorePrintedDatesFromRawText(
    healSummaryOverriddenAmounts(stabilizePageAccountIdentities(preparedTransactions))
  ));
  const { transactions: observations, mergedPagesByAccount } = deduplicateTransactions([...stabilized, ...protectedTransactions]);
  const canonicalObservations = observations.filter(transaction => !transaction.excludedFromAnalysis);
  const settlementRepaired = repairPeriodicSettlementRows(canonicalObservations.filter(transaction => !isEvidenceOnly(transaction)));
  const calibrated = calibrateDirectionsByBalanceMath(settlementRepaired);
  const analyzedTransactions = [
    ...healOcrBalanceAndAmountDiscrepancies(calibrated),
    ...canonicalObservations.filter(isEvidenceOnly)
  ];
  const analyzedById = new Map(analyzedTransactions.map(transaction => [transaction.id, transaction]));
  const transactions = observations.map(transaction => analyzedById.get(transaction.id) || transaction);
  for (const transaction of transactions) {
    // Protected observations retain every review reason, including missing zero
    // amounts and candidate conflicts. Balance equality is not source evidence.
    if (isEvidenceOnly(transaction)) continue;
    const isFeeWaiverRow = isFeeWaiver(transaction);
    const isConfirmedZeroSettlement = isBalanceConfirmedZeroSettlement(transaction, analyzedTransactions);
    if ((isFeeWaiverRow || isConfirmedZeroSettlement) && transaction.dataQualityIssues) {
      transaction.dataQualityIssues = transaction.dataQualityIssues.filter(q => q !== 'INVALID_AMOUNT');
      if (!transaction.dataQualityIssues.length && transaction.reviewStatus === 'PENDING') {
        transaction.extractionConfidence = Math.max(transaction.extractionConfidence ?? 0, 0.9);
        transaction.reviewStatus = 'AUTO_PASSED';
      }
    }
    if (!isEvidenceOnly(transaction)) refreshFieldEvidence(transaction);
  }
  const transactionsByAccount = new Map<string, StandardTransaction[]>();
  for (const transaction of analyzedTransactions) {
    const key = accountIdentityKey(transaction);
    transactionsByAccount.set(key, [...(transactionsByAccount.get(key) || []), transaction]);
  }

  const sourceAccounts = new Map<string, BankAccount[]>();
  for (const account of publicAccounts.filter(account => !isDocumentReviewAccount(account))) {
    const key = accountIdentityKey(account);
    sourceAccounts.set(key, [...(sourceAccounts.get(key) || []), account]);
  }

  const allWarnings = [...new Set(publicAccounts.flatMap(account => account.parseWarnings || []))]
    .filter(warning => !isLegacyDerivedWarning(warning));
  const pageWarnings = allWarnings.filter(warning => warningPage(warning));
  const unscopedWarnings = allWarnings.filter(warning => !warningPage(warning));
  const coveredWarningSet = new Set<string>();
  const assignedUnscopedWarningSet = new Set<string>();
  const keys = new Set([...transactionsByAccount.keys(), ...sourceAccounts.keys()]);
  const accounts: BankAccount[] = [];

  for (const key of keys) {
    const accountTransactions = [...(transactionsByAccount.get(key) || [])].sort(compareSourceOrder);
    const originals = sourceAccounts.get(key) || [];
    if (!accountTransactions.length) continue;
    const originalPages = accountTransactions.map(item => item.rawPageNumber).filter((page): page is number => Boolean(page));
    const mergedPages = mergedPagesByAccount.get(key) || new Set<number>();
    const pages = [...new Set([...originalPages, ...mergedPages])].sort((a, b) => a - b);
    const pageSet = new Set(pages);
    const scopedPageWarnings = pageWarnings.filter(warning => {
      const page = warningPage(warning);
      if (!page || !pageSet.has(page)) return false;
      coveredWarningSet.add(warning);
      return true;
    });
    // File-level parser warnings belong to a real account when one exists. Assign each
    // warning once so a shared parser caveat neither creates a fake zero-transaction
    // account nor appears repeatedly on every account extracted from the same file.
    const accountUnscopedWarnings = originals
      .flatMap(original => original.parseWarnings || [])
      .filter(warning => !isLegacyDerivedWarning(warning) && !warningPage(warning))
      .filter(warning => {
        if (assignedUnscopedWarningSet.has(warning)) return false;
        assignedUnscopedWarningSet.add(warning);
        return true;
      });
    const parseWarnings = [...new Set([...scopedPageWarnings, ...accountUnscopedWarnings])];
    const representative = bestOriginal(originals) || minimalAccount(accountTransactions[0]);
    const accountName = cleanAccountHolderName(mostFrequent(accountTransactions.map(item => item.accountName)) || representative.accountName);
    const bankName = normalizeBankName(mostFrequent(accountTransactions.map(item => item.bankName).filter(name => isUsefulBankName(name, accountName)))
      || (isUsefulBankName(representative.bankName, accountName) ? representative.bankName : '')
      || '待核验银行');
    const totalIn = sum(accountTransactions.filter(item => item.direction === 'IN').map(item => item.amount));
    const totalOut = sum(accountTransactions.filter(item => item.direction === 'OUT').map(item => item.amount));
    const dates = accountTransactions.map(item => item.transactionDate).filter(Boolean).sort();
    const reviewIssues = [...new Map(originals.flatMap(item => item.reviewIssues || []).map(issue => [issue.id, issue])).values()];
    const continuityIssues = balanceContinuityIssues(accountTransactions);
    const hasDerivedIssues = accountTransactions.some(item => (item.extractionConfidence ?? 1) < 0.8
      || (item.amount <= 0 && !isFeeWaiver(item) && !isBalanceConfirmedZeroSettlement(item, accountTransactions))
      || !item.transactionDate || item.direction === 'UNKNOWN')
      || continuityIssues.length > 0;

    const balanceAvailable = accountTransactions.some(item => item.balanceAvailable !== false);
    const chronological = chronologicalTransactions(accountTransactions);
    const firstWithBalance = chronological.find(item => item.balanceAvailable !== false && item.balance != null);
    const lastWithBalance = [...chronological].reverse().find(item => item.balanceAvailable !== false && item.balance != null);

    let startBalance = representative.startBalance ?? 0;
    let endBalance = representative.endBalance ?? (lastWithBalance?.balance ?? 0);

    if (firstWithBalance && firstWithBalance.balance != null && firstWithBalance.amount > 0) {
      const inferredStart = firstWithBalance.direction === 'IN'
        ? firstWithBalance.balance - firstWithBalance.amount
        : firstWithBalance.direction === 'OUT'
        ? firstWithBalance.balance + firstWithBalance.amount
        : firstWithBalance.balance;
      startBalance = inferredStart;
    }
    if (lastWithBalance && lastWithBalance.balance != null) {
      endBalance = lastWithBalance.balance;
    }

    const balanceDiff = balanceAvailable ? Math.abs(startBalance + totalIn - totalOut - endBalance) : 0;

    accounts.push({
      ...representative,
      accountNumber: accountTransactions[0].accountNumber,
      accountName,
      bankName,
      ownerType: preferredOwnerType(originals),
      fileName: accountTransactions[0].rawSourceFile,
      totalIn, totalOut, transactionCount: accountTransactions.length,
      startDate: dates[0] || '', endDate: dates[dates.length - 1] || '',
      startBalance, endBalance, balanceAvailable,
      balanceDiff, isBalanced: balanceAvailable && Math.round(balanceDiff * 100) === 0,
      parseWarnings, coveredPages: pages,
      parseStatus: parseWarnings.length || hasDerivedIssues ? 'NEEDS_REVIEW' : 'COMPLETE',
      balanceContinuityIssueCount: continuityIssues.length,
      reviewIssues
    });
  }

  // Keep a real, visible import record for files that contain account information
  // but no transaction rows. Without this, normalization turns a legitimate
  // zero-transaction result into a synthetic “待归属页面” account or drops it.
  for (const original of publicAccounts) {
    if (original.transactionCount !== 0 || isDocumentReviewAccount(original)) continue;
    if (transactionsByAccount.has(accountIdentityKey(original))) continue;
    const alreadyPreserved = accounts.some(account => (
      account.fileName === original.fileName
      && accountIdentityKey(account) === accountIdentityKey(original)
    ));
    if (alreadyPreserved) continue;
    const retainedWarnings = (original.parseWarnings || []).filter(warning => {
      if (warningPage(warning)) {
        coveredWarningSet.add(warning);
        return true;
      }
      if (assignedUnscopedWarningSet.has(warning)) return false;
      assignedUnscopedWarningSet.add(warning);
      return true;
    });
    const isIncomplete = original.parseStatus === 'INCOMPLETE'
      || retainedWarnings.some(warning => /连续识别失败|服务暂时不可用|未能完整获取/.test(warning));
    accounts.push({
      ...original,
      parseWarnings: [...new Set(retainedWarnings)],
      totalIn: 0,
      totalOut: 0,
      transactionCount: 0,
      startDate: '',
      endDate: '',
      isBalanced: false,
      balanceAvailable: false,
      parseStatus: isIncomplete ? 'INCOMPLETE' : 'NEEDS_REVIEW'
    });
  }

  const orphanWarnings = pageWarnings.filter(warning => !coveredWarningSet.has(warning));
  let unassignedUnscopedWarnings = unscopedWarnings.filter(warning => !assignedUnscopedWarningSet.has(warning));
  // Previously normalized browser data may already contain file-level warnings on a
  // synthetic review account. Migrate those warnings back to a real account from the
  // same source file so refreshing an existing import also removes the stale card.
  if (accounts.length && unassignedUnscopedWarnings.length) {
    for (const warning of unassignedUnscopedWarnings) {
      const sourceFile = publicAccounts.find(account => account.parseWarnings?.includes(warning))?.fileName;
      const target = accounts.find(account => sourceFile && account.fileName === sourceFile) || accounts[0];
      target.parseWarnings = [...new Set([...(target.parseWarnings || []), warning])];
      target.parseStatus = 'NEEDS_REVIEW';
      assignedUnscopedWarningSet.add(warning);
    }
    unassignedUnscopedWarnings = unscopedWarnings.filter(warning => !assignedUnscopedWarningSet.has(warning));
  }
  const documentWarnings = [...new Set([...unassignedUnscopedWarnings, ...orphanWarnings])];
  if (documentWarnings.length) {
    const existing = publicAccounts.find(isDocumentReviewAccount);
    const sourceFile = existing?.fileName || transactions[0]?.rawSourceFile || publicAccounts[0]?.fileName || '';
    accounts.push({
      ...(existing || minimalDocumentAccount(sourceFile)),
      accountNumber: `待归属页面-${sourceFile}`, accountName: '待归属页面', bankName: '待核对', ownerType: 'UNKNOWN',
      fileName: sourceFile, transactionCount: 0, totalIn: 0, totalOut: 0,
      parseStatus: documentWarnings.some(warning => /连续识别失败|服务暂时不可用|未能完整获取/.test(warning))
        ? 'INCOMPLETE'
        : 'NEEDS_REVIEW',
      parseWarnings: documentWarnings,
      coveredPages: [...new Set(orphanWarnings.map(warningPage).filter((page): page is number => Boolean(page)))].sort((a, b) => a - b)
    });
  }
  return { accounts, transactions };
}

function canonicalStoredAccountNumber(value: string, sourceFile: string, sourceDocumentId: string | undefined, candidates: BankAccount[]): string {
  const normalized = normalizeAccountIdentityPart(value || '');
  if (!isReliableAccountNumber(normalized)) return value;
  const matches = [...new Set(candidates
    .filter(account => (sourceDocumentId && account.sourceDocumentId
      ? account.sourceDocumentId === sourceDocumentId
      : account.fileName === sourceFile) && areStoredAccountAliases(account.accountNumber, normalized))
    .map(account => normalizeAccountIdentityPart(account.accountNumber)))];
  if (!matches.length) return normalized;
  const longestLength = Math.max(...matches.map(candidate => candidate.length));
  const longest = matches.filter(candidate => candidate.length === longestLength);
  return longest.length === 1 ? longest[0] : normalized;
}

function areStoredAccountAliases(left: string, right: string): boolean {
  const a = normalizeAccountIdentityPart(left || '');
  const b = normalizeAccountIdentityPart(right || '');
  if (a === b) return true;
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const omittedPrefixLength = longer.length - shorter.length;
  return shorter.length >= 10
    && omittedPrefixLength >= 1
    && omittedPrefixLength <= 4
    && longer.endsWith(shorter);
}

/**
 * Repairs highly constrained interest-settlement OCR failures without relying on
 * bank names or document-specific row numbers:
 *
 * 1. A syntactically valid but out-of-sequence year is repaired only when the
 *    statement has a clear physical date direction and the same month/day can
 *    be moved into that direction by changing the year alone.
 * 2. A missing settlement amount is restored only when two adjacent physical
 *    rows for the same account expose balances whose exact delta agrees with
 *    the extracted IN/OUT direction.
 *
 * The original OCR text remains in rawText and the correction reason is kept
 * for traceability, while deterministic rows no longer create blanket review
 * tasks merely because the amount field was blank.
 */
function repairPeriodicSettlementRows(transactions: StandardTransaction[]): StandardTransaction[] {
  const byAccount = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    const key = accountIdentityKey(transaction);
    byAccount.set(key, [...(byAccount.get(key) || []), transaction]);
  }

  for (const accountTransactions of byAccount.values()) {
    const ordered = [...accountTransactions].sort(compareSourceOrder);
    const dateDirection = inferPhysicalDateDirection(ordered);
    let previousDated: StandardTransaction | undefined;

    for (let index = 0; index < ordered.length; index++) {
      const transaction = ordered[index];
      const previous = ordered[index - 1];
      if (previous && isLikelyConsolidatedAccountBoundary(previous, transaction)) {
        previousDated = undefined;
      }
      if (isPeriodicSettlement(transaction) && previousDated && dateDirection !== 0) {
        repairSettlementYear(transaction, previousDated, dateDirection);
      }

      if (previous && isPeriodicSettlement(transaction)) {
        repairSettlementAmount(transaction, previous);
      }

      if (parseIsoDate(transaction.transactionDate)) previousDated = transaction;
    }
  }

  return transactions;
}

/**
 * Repairs a single implausible OCR year only when the rest of the same account
 * establishes a compact statement period.  This deliberately does not clamp
 * genuine long-running statements or alter month/day values.
 */
function repairOutlierOcrYears(transactions: StandardTransaction[]): StandardTransaction[] {
  const groups = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    const key = accountIdentityKey(transaction);
    groups.set(key, [...(groups.get(key) || []), transaction]);
  }
  for (const rows of groups.values()) {
    if (rows.length < 5) continue;
    const dated = rows.map(row => ({ row, date: parseIsoDate(row.transactionDate) })).filter(
      (item): item is { row: StandardTransaction; date: Date } => Boolean(item.date)
    );
    if (dated.length < 5) continue;
    for (const candidate of dated) {
      const peerYears = dated.filter(item => item !== candidate).map(item => item.date.getUTCFullYear());
      const peerMin = Math.min(...peerYears);
      const peerMax = Math.max(...peerYears);
      if (peerMax - peerMin > 3) continue;
      const currentYear = candidate.date.getUTCFullYear();
      if (currentYear >= peerMin - 2 && currentYear <= peerMax + 2) continue;
      const ordered = [...rows].sort(compareSourceOrder);
      const index = ordered.indexOf(candidate.row);
      const neighbours = [ordered[index - 1], ordered[index + 1]]
        .map(row => parseIsoDate(row?.transactionDate))
        .filter((date): date is Date => date !== undefined)
        .filter(date => date.getUTCFullYear() >= peerMin && date.getUTCFullYear() <= peerMax);
      const possible = Array.from({ length: peerMax - peerMin + 1 }, (_, offset) => peerMin + offset)
        .map(year => new Date(Date.UTC(year, candidate.date.getUTCMonth(), candidate.date.getUTCDate())))
        .filter(date => date.getUTCMonth() === candidate.date.getUTCMonth() && date.getUTCDate() === candidate.date.getUTCDate());
      if (!possible.length) continue;
      const repaired = possible.sort((a, b) => yearCandidateScore(a, neighbours) - yearCandidateScore(b, neighbours))[0];
      const repairedDate = isoDate(repaired);
      const timeSuffix = candidate.row.transactionTime.match(/(?:T|\s)(\d{2}:\d{2}(?::\d{2})?)$/)?.[1];
      candidate.row.transactionDate = repairedDate;
      candidate.row.transactionTime = timeSuffix ? `${repairedDate} ${timeSuffix}` : repairedDate;
      candidate.row.correctionReason = appendCorrectionReason(candidate.row.correctionReason, '系统依据同账户主要时间范围修正异常年份');
      candidate.row.reviewStatus = 'CORRECTED';
    }
  }
  return transactions;
}

function restorePrintedDatesFromRawText(transactions: StandardTransaction[]): StandardTransaction[] {
  for (const transaction of transactions) {
    const current = parseIsoDate(transaction.transactionDate);
    if (!current || !transaction.rawText) continue;
    const printed = [...transaction.rawText.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g)]
      .map(match => `${match[1]}-${match[2]}-${match[3]}`)
      .filter(date => Boolean(parseIsoDate(date)));
    if (!printed.length || printed.includes(transaction.transactionDate)) continue;
    const sameMonthDay = printed.find(date => date.slice(5) === transaction.transactionDate.slice(5));
    if (!sameMonthDay || Math.abs(Number(sameMonthDay.slice(0, 4)) - current.getUTCFullYear()) < 2) continue;
    const timeSuffix = transaction.transactionTime.match(/(?:T|\s)(\d{2}:\d{2}(?::\d{2})?)$/)?.[1];
    transaction.transactionDate = sameMonthDay;
    transaction.transactionTime = timeSuffix ? `${sameMonthDay} ${timeSuffix}` : sameMonthDay;
    transaction.correctionReason = appendCorrectionReason(transaction.correctionReason, '系统依据原始行印刷日期恢复异常年份');
    transaction.reviewStatus = 'CORRECTED';
  }
  return transactions;
}

function yearCandidateScore(candidate: Date, neighbours: Date[]): number {
  if (!neighbours.length) return 0;
  return neighbours.reduce((sum, date) => sum + Math.abs(candidate.getTime() - date.getTime()), 0);
}

function isPeriodicSettlement(transaction: StandardTransaction): boolean {
  const text = `${transaction.summary || ''} ${transaction.counterpartyName || ''} ${transaction.rawText || ''}`;
  return /结息|利息结算|计息/.test(text);
}

function isLikelyConsolidatedAccountBoundary(
  previous: StandardTransaction,
  current: StandardTransaction
): boolean {
  if (!isPeriodicSettlement(previous) || !isPeriodicSettlement(current)) return false;
  if (previous.balanceAvailable === false || current.balanceAvailable === false) return false;
  if (previous.balance == null || current.balance == null || current.direction === 'UNKNOWN') return false;
  const expectedBalance = previous.balance + (current.direction === 'IN' ? current.amount : -current.amount);
  const gap = Math.abs(expectedBalance - current.balance);
  return gap >= Math.max(1000, Math.abs(current.amount) * 20);
}

function inferPhysicalDateDirection(transactions: StandardTransaction[]): -1 | 0 | 1 {
  let forward = 0;
  let reverse = 0;
  for (let index = 1; index < transactions.length; index++) {
    const previous = parseIsoDate(transactions[index - 1].transactionDate);
    const current = parseIsoDate(transactions[index].transactionDate);
    if (!previous || !current) continue;
    const yearGap = Math.abs(current.getUTCFullYear() - previous.getUTCFullYear());
    if (yearGap >= 2) continue; // likely OCR year damage; do not let it vote on orientation
    if (current.getTime() > previous.getTime()) forward++;
    else if (current.getTime() < previous.getTime()) reverse++;
  }
  if (forward >= reverse + 2) return 1;
  if (reverse >= forward + 2) return -1;
  return 0;
}

function repairSettlementYear(
  transaction: StandardTransaction,
  previous: StandardTransaction,
  direction: -1 | 1
): void {
  const currentDate = parseIsoDate(transaction.transactionDate);
  const previousDate = parseIsoDate(previous.transactionDate);
  if (!currentDate || !previousDate) return;
  // Never move away from a date that is explicitly printed in the preserved
  // source row.  Balance blocks from another account can otherwise make a
  // consolidated statement look like one impossible chronological sequence.
  if (transaction.correctionReason?.includes('依据原始行印刷日期恢复异常年份')) return;
  const alreadyOrdered = direction === 1
    ? currentDate.getTime() > previousDate.getTime()
    : currentDate.getTime() < previousDate.getTime();
  if (alreadyOrdered) return;
  if (Math.abs(currentDate.getUTCFullYear() - previousDate.getUTCFullYear()) < 2) return;

  const month = currentDate.getUTCMonth();
  const day = currentDate.getUTCDate();
  let candidateYear = previousDate.getUTCFullYear();
  let candidate = new Date(Date.UTC(candidateYear, month, day));
  if (direction === 1 && candidate.getTime() <= previousDate.getTime()) {
    candidateYear++;
    candidate = new Date(Date.UTC(candidateYear, month, day));
  } else if (direction === -1 && candidate.getTime() >= previousDate.getTime()) {
    candidateYear--;
    candidate = new Date(Date.UTC(candidateYear, month, day));
  }
  if (candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) return;
  if (Math.abs(candidateYear - currentDate.getUTCFullYear()) < 2) return;

  const repairedDate = isoDate(candidate);
  const timeSuffix = transaction.transactionTime.match(/(?:T|\s)(\d{2}:\d{2}(?::\d{2})?)$/)?.[1];
  transaction.transactionDate = repairedDate;
  transaction.transactionTime = timeSuffix ? `${repairedDate} ${timeSuffix}` : repairedDate;
  transaction.correctionReason = appendCorrectionReason(
    transaction.correctionReason,
    '系统依据同账户原始行日期顺序修正结息年份'
  );
  transaction.reviewStatus = 'CORRECTED';
}

function repairSettlementAmount(transaction: StandardTransaction, previous: StandardTransaction): void {
  const hasInvalidAmount = transaction.amount <= 0
    || Boolean(transaction.dataQualityIssues?.includes('INVALID_AMOUNT'));
  if (!hasInvalidAmount || transaction.direction === 'UNKNOWN') return;
  if (transaction.balanceAvailable === false || previous.balanceAvailable === false) return;
  if (transaction.balance == null || previous.balance == null) return;

  const signedDelta = Math.round((transaction.balance - previous.balance) * 100) / 100;
  const directionMatches = transaction.direction === 'IN' ? signedDelta > 0 : signedDelta < 0;
  if (!directionMatches) return;
  const impliedAmount = Math.abs(signedDelta);
  if (!Number.isFinite(impliedAmount) || impliedAmount <= 0) return;

  if (transaction.originalAmount === undefined) transaction.originalAmount = transaction.amount;
  transaction.amount = impliedAmount;
  transaction.dataQualityIssues = (transaction.dataQualityIssues || []).filter(issue => issue !== 'INVALID_AMOUNT');
  transaction.correctionReason = appendCorrectionReason(
    transaction.correctionReason,
    '系统依据同账户相邻原始行余额精确恢复结息金额'
  );
  if (!transaction.dataQualityIssues.length) {
    transaction.extractionConfidence = Math.max(transaction.extractionConfidence ?? 0, 0.9);
    transaction.reviewStatus = 'CORRECTED';
  }
}

function parseIsoDate(value?: string): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || isoDate(parsed) !== value ? undefined : parsed;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function appendCorrectionReason(current: string | undefined, reason: string): string {
  if (!current) return reason;
  return current.includes(reason) ? current : `${current}；${reason}`;
}

export function cleanAccountHolderName(value: string): string {
  return (value || '未知户名')
    .replace(/\.(pdf|xlsx?|csv)$/i, '')
    .replace(/(?:银行)?流水(?:合并)?$/u, '')
    .trim() || '未知户名';
}

function stabilizePageAccountIdentities(input: StandardTransaction[]): StandardTransaction[] {
  const transactions = input.map(transaction => ({ ...transaction }));
  const pages = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    if (!transaction.rawPageNumber) continue;
    const key = JSON.stringify([transaction.sourceDocumentId || transaction.rawSourceFile, transaction.rawPageNumber]);
    pages.set(key, [...(pages.get(key) || []), transaction]);
  }
  for (const pageTransactions of [...pages.values()].sort((a, b) => (a[0].rawPageNumber || 0) - (b[0].rawPageNumber || 0))) {
    const page = pageTransactions[0].rawPageNumber!;
    const reliable = pageTransactions.filter(item => isReliableAccountNumber(item.accountNumber));
    const reliableKeys = new Set(reliable.map(accountNumberKey));
    if (reliableKeys.size === 1) {
      // A genuinely single-account page may contain a few rows whose account
      // cell was not read. Fill only those pages; never collapse a consolidated
      // page that already contains two or more reliable owner accounts.
      const counts = new Map<string, { item: StandardTransaction; count: number }>();
      for (const item of reliable) {
        const k = accountNumberKey(item);
        const curr = counts.get(k);
        counts.set(k, { item, count: (curr?.count || 0) + 1 });
      }
      const primary = [...counts.values()].sort((a, b) => b.count - a.count)[0].item;
      for (const transaction of pageTransactions) {
        copyIdentity(transaction, primary);
      }
      continue;
    }
    if (reliableKeys.size > 1) continue;
    const previous = [...transactions].reverse().find(item => sameSource(item, pageTransactions[0]) && (item.rawPageNumber || 0) < page && isReliableAccountNumber(item.accountNumber));
    const next = transactions.find(item => sameSource(item, pageTransactions[0]) && (item.rawPageNumber || 0) > page && isReliableAccountNumber(item.accountNumber));
    if (previous && next && accountNumberKey(previous) === accountNumberKey(next)) {
      for (const transaction of pageTransactions) copyIdentity(transaction, previous);
    }
  }

  // Cross-page account aliasing / bridging for interleaved statements
  return unifyInterleavedStatementAccounts(transactions);
}

function unifyInterleavedStatementAccounts(transactions: StandardTransaction[]): StandardTransaction[] {
  const accountsByBank = new Map<string, Set<string>>();
  for (const t of transactions) {
    if (!isReliableAccountNumber(t.accountNumber)) continue;
    const b = normalizeAccountIdentityPart(t.bankName || '');
    const acc = normalizeAccountIdentityPart(t.accountNumber);
    const set = accountsByBank.get(b) || new Set();
    set.add(acc);
    accountsByBank.set(b, set);
  }

  for (const [, accSet] of accountsByBank) {
    if (accSet.size < 2) continue;
    const accList = [...accSet];
    for (let i = 0; i < accList.length; i++) {
      for (let j = i + 1; j < accList.length; j++) {
        const acc1 = accList[i];
        const acc2 = accList[j];
        const combined = transactions
          .filter(t => {
            const a = normalizeAccountIdentityPart(t.accountNumber);
            return a === acc1 || a === acc2;
          })
          .sort((a, b) => (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0));

        let transitions = 0;
        let continuousHits = 0;
        for (let k = 1; k < combined.length; k++) {
          const prev = combined[k - 1];
          const curr = combined[k];
          const prevAcc = normalizeAccountIdentityPart(prev.accountNumber);
          const currAcc = normalizeAccountIdentityPart(curr.accountNumber);
          if (prevAcc !== currAcc) {
            transitions++;
            if (prev.balance != null && curr.balance != null && curr.direction !== 'UNKNOWN') {
              const delta = curr.direction === 'IN' ? curr.amount : -curr.amount;
              if (Math.abs(prev.balance + delta - curr.balance) < 1) {
                continuousHits++;
              }
            }
          }
        }

        // Never merge two merely interleaved accounts.  They may be separate
        // owner accounts printed in alternating sections, or an owner-account
        // and card-number column.  Alias repair is allowed only when the account
        // strings themselves are an obvious OCR variant and the page sequence
        // also provides corroborating continuity.
        const duplicateHits = crossAccountDuplicateHits(combined, acc1, acc2);
        const conflictingOverlapHits = crossAccountConflictingOverlapHits(combined, acc1, acc2);
        const hasMixedDuplicateAndConflictEvidence = duplicateHits >= 2 && conflictingOverlapHits >= 2;
        if (areLikelyOcrAccountAliases(acc1, acc2)
          && !hasMixedDuplicateAndConflictEvidence
          && (continuousHits > 0 || transitions >= 2 || duplicateHits >= 2)) {
          const count1 = combined.filter(t => normalizeAccountIdentityPart(t.accountNumber) === acc1).length;
          const count2 = combined.filter(t => normalizeAccountIdentityPart(t.accountNumber) === acc2).length;
          const targetAcc = count1 >= count2 ? acc1 : acc2;
          const sourceAcc = count1 >= count2 ? acc2 : acc1;
          const targetItem = combined.find(t => normalizeAccountIdentityPart(t.accountNumber) === targetAcc)!;

          for (const t of transactions) {
            if (normalizeAccountIdentityPart(t.accountNumber) === sourceAcc) {
              t.accountNumber = targetItem.accountNumber;
              if (targetItem.accountName) t.accountName = targetItem.accountName;
            }
          }
        }
      }
    }
  }

  return transactions;
}

function crossAccountConflictingOverlapHits(
  transactions: StandardTransaction[], leftAccount: string, rightAccount: string
): number {
  const left = transactions.filter(item => normalizeAccountIdentityPart(item.accountNumber) === leftAccount);
  const right = transactions.filter(item => normalizeAccountIdentityPart(item.accountNumber) === rightAccount);
  let conflicts = 0;
  for (const a of left) {
    const sameEvent = right.find(b =>
      a.transactionDate === b.transactionDate
      && a.direction === b.direction
      && Math.abs(a.amount - b.amount) < 0.01
    );
    if (!sameEvent) continue;
    const balanceConflict = a.balanceAvailable !== false && sameEvent.balanceAvailable !== false
      && Math.abs(a.balance - sameEvent.balance) >= 0.01;
    const timeA = extractTimeOfDay(a.transactionTime);
    const timeB = extractTimeOfDay(sameEvent.transactionTime);
    const timeConflict = Boolean(timeA && timeB && !timesCompatible(timeA, timeB));
    if (balanceConflict || timeConflict) conflicts += 1;
  }
  return conflicts;
}

function areLikelyOcrAccountAliases(left: string, right: string): boolean {
  if (left === right) return true;
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return false;
  if (Math.abs(left.length - right.length) > 1 || Math.min(left.length, right.length) < 14) return false;
  if (left.slice(-4) !== right.slice(-4)) return false;
  return boundedEditDistance(left, right, 2) <= 2;
}

function boundedEditDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= right.length; j++) {
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function crossAccountDuplicateHits(rows: StandardTransaction[], first: string, second: string): number {
  const left = rows.filter(row => normalizeAccountIdentityPart(row.accountNumber) === first);
  const right = rows.filter(row => normalizeAccountIdentityPart(row.accountNumber) === second);
  let hits = 0;
  const used = new Set<number>();
  for (const candidate of left) {
    const index = right.findIndex((row, rowIndex) => !used.has(rowIndex)
      && row.transactionDate === candidate.transactionDate
      && row.direction === candidate.direction
      && Math.abs(row.amount - candidate.amount) < 0.01
      && (row.balanceAvailable === false || candidate.balanceAvailable === false || Math.abs(row.balance - candidate.balance) < 0.01));
    if (index >= 0) {
      used.add(index);
      hits += 1;
    }
  }
  return hits;
}

function healSummaryOverriddenAmounts(transactions: StandardTransaction[]): StandardTransaction[] {
  const sorted = [...transactions].sort((a, b) => (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0));
  const creditCardKeys = creditCardAccountKeys(sorted);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (creditCardKeys.has(accountIdentityKey(curr))) continue;
    if (
      prev.balanceAvailable === false ||
      curr.balanceAvailable === false ||
      curr.direction === 'UNKNOWN' ||
      prev.balance == null ||
      curr.balance == null
    ) {
      continue;
    }

    const delta = curr.direction === 'IN' ? curr.amount : -curr.amount;
    const diff = Math.abs(prev.balance + delta - curr.balance);
    if (diff >= 1) {
      const impliedAmount = curr.direction === 'OUT' ? prev.balance - curr.balance : curr.balance - prev.balance;
      if (impliedAmount > 0) {
        const impliedRounded = Math.round(impliedAmount * 100) / 100;
        const impliedStr = impliedRounded.toFixed(2);
        const currAmtStr = curr.amount.toFixed(2);
        const summaryHasCurrAmt = curr.summary && (curr.summary.includes(currAmtStr) || curr.summary.includes(String(curr.amount)));
        const rawTextHasImplied = curr.rawText && (curr.rawText.includes(impliedStr) || curr.rawText.includes(String(impliedRounded)));
        if (summaryHasCurrAmt && rawTextHasImplied) {
          recordCorrection(curr, '摘要金额与交易列冲突，系统依据原始行及余额关系提出修正');
          curr.amount = impliedRounded;
        }
      }
    }
  }
  return transactions;
}

function copyIdentity(target: StandardTransaction, source: StandardTransaction): void {
  target.accountNumber = source.accountNumber;
  target.accountName = source.accountName;
  target.bankName = source.bankName;
}

function accountNumberKey(value: Pick<StandardTransaction, 'accountNumber'>): string {
  return normalizeAccountIdentityPart(value.accountNumber);
}

function isDocumentReviewAccount(account: BankAccount): boolean {
  return account.ownerType === 'UNKNOWN' && (/待归属页面/.test(account.accountNumber) || account.transactionCount === 0);
}

function isLegacyDerivedWarning(warning: string): boolean {
  return /第\s*\d+\s*页第\s*\d+\s*笔交易余额不连续/.test(warning)
    || /识别置信度低于\s*80%/.test(warning)
    || /第\s*\d+\s*页第\s*\d+\s*笔(?:收支方向|交易金额)无法确认/.test(warning);
}

function publicParserWarning(warning: string): string {
  return warning
    .replace(/Gemini(?:\s*3\.8\s*Flash)?/gi, '智能识别')
    .replace(/Qwen/gi, '智能识别')
    .replace(/智能识别\s*直传/g, '智能识别');
}

function warningPage(warning: string): number | undefined {
  const match = warning.match(/第\s*(\d+)\s*页/);
  return match ? Number(match[1]) : undefined;
}

function upgradeLegacyGeminiReviewStatus(transaction: StandardTransaction): StandardTransaction {
  const isLegacyBlanketPending = transaction.extractionMethod === 'GEMINI_DIRECT_PDF'
    && transaction.reviewStatus === 'PENDING'
    && transaction.extractionConfidence === 0.75
    && !transaction.dataQualityIssues?.length
    && !transaction.correctionReason;
  return isLegacyBlanketPending
    ? { ...transaction, extractionConfidence: 0.9, reviewStatus: 'AUTO_PASSED' }
    : transaction;
}

function restoreUnsupportedBalanceCorrections(transactions: StandardTransaction[]): StandardTransaction[] {
  const creditCardKeys = creditCardAccountKeys(transactions);
  return transactions.map(transaction => {
    const reason = transaction.correctionReason || '';
    const isBridgeCorrection = reason === '系统依据前后余额桥接关系提出金额及余额修正';
    const isTwoRowCorrection = reason === '系统依据相邻余额关系提出金额修正';
    if (!isBridgeCorrection && !isTwoRowCorrection) return transaction;

    const strictDigitBridge = isBridgeCorrection
      && transaction.originalAmount !== undefined
      && transaction.originalBalance !== undefined
      && isOcrDigitVariant(transaction.originalAmount.toFixed(2), transaction.amount.toFixed(2))
      && isOcrDigitVariant(transaction.originalBalance.toFixed(2), transaction.balance.toFixed(2));
    if (!creditCardKeys.has(accountIdentityKey(transaction)) && strictDigitBridge) {
      return {
        ...transaction,
        reviewStatus: 'CORRECTED'
      };
    }
    if (!creditCardKeys.has(accountIdentityKey(transaction)) && isTwoRowCorrection) return transaction;

    return {
      ...transaction,
      amount: transaction.originalAmount ?? transaction.amount,
      balance: transaction.originalBalance ?? transaction.balance,
      reviewStatus: transaction.dataQualityIssues?.length ? 'PENDING' : 'AUTO_PASSED',
      correctionReason: undefined,
      originalAmount: undefined,
      originalBalance: undefined,
      originalDirection: undefined
    };
  });
}

function creditCardAccountKeys(transactions: StandardTransaction[]): Set<string> {
  const groups = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    const key = accountIdentityKey(transaction);
    groups.set(key, [...(groups.get(key) || []), transaction]);
  }
  return new Set([...groups].filter(([, rows]) => isCreditCardStatement(rows)).map(([key]) => key));
}

function isUsefulBankName(value: string, accountName = ''): boolean {
  const normalized = (value || '').trim();
  if (!normalized || /待核验|待核对|未知/.test(normalized)) return false;
  const owner = cleanAccountHolderName(accountName || '');
  // A common OCR hallucination concatenates the customer's name with
  // “商业银行”.  It is safer to show 待核验银行 than attribute evidence to a
  // non-existent institution.
  if (owner.length >= 2 && normalized.includes(owner) && /银行/.test(normalized)) return false;
  return /银行|农信|信用社|农商|邮储|财务公司/.test(normalized);
}

function normalizeBankName(value: string): string {
  const normalized = (value || '').trim();
  const aliases: Record<string, string> = {
    '绵阳商业银行': '绵阳市商业银行'
  };
  return aliases[normalized] || normalized;
}

function mostFrequent(values: string[]): string {
  const counts = new Map<string, { value: string; count: number }>();
  for (const value of values.filter(Boolean)) {
    const key = normalizeAccountIdentityPart(value);
    const current = counts.get(key);
    counts.set(key, { value, count: (current?.count || 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.length - b.value.length)[0]?.value || '';
}

function preferredOwnerType(accounts: BankAccount[]): BankAccount['ownerType'] {
  return accounts.find(item => item.ownerType !== 'UNKNOWN')?.ownerType || 'DEBTOR_MAIN';
}

function bestOriginal(accounts: BankAccount[]): BankAccount | undefined {
  return [...accounts].sort((a, b) => b.transactionCount - a.transactionCount)[0];
}

function minimalAccount(transaction: StandardTransaction): BankAccount {
  return {
    accountNumber: transaction.accountNumber, accountName: transaction.accountName, bankName: transaction.bankName,
    ownerType: 'DEBTOR_MAIN', fileName: transaction.rawSourceFile, fileType: 'pdf', totalIn: 0, totalOut: 0,
    transactionCount: 0, startDate: '', endDate: '', startBalance: 0, endBalance: 0,
    isBalanced: false, balanceDiff: 0, balanceAvailable: transaction.balanceAvailable !== false,
    sourceDocumentId: transaction.sourceDocumentId,
    sourceContentHash: transaction.sourceContentHash,
    extractionRunId: transaction.extractionRunId
  };
}

function minimalDocumentAccount(sourceFile: string): BankAccount {
  return {
    accountNumber: '', accountName: '待归属页面', bankName: '待核对', ownerType: 'UNKNOWN', fileName: sourceFile,
    fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0, startDate: '', endDate: '', startBalance: 0,
    endBalance: 0, isBalanced: false, balanceDiff: 0, balanceAvailable: false
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}

export interface DeduplicateTransactionsResult {
  transactions: StandardTransaction[];
  mergedPagesByAccount: Map<string, Set<number>>;
}

export function deduplicateTransactions(transactions: StandardTransaction[]): DeduplicateTransactionsResult {
  const result: StandardTransaction[] = [];
  const representatives: StandardTransaction[] = [];
  const mergedPagesByAccount = new Map<string, Set<number>>();
  const matchedTargetsByPage = new Map<number, Set<number>>();

  const sorted = transactions.map(transaction => ({
    ...transaction,
    duplicateOfTransactionId: undefined,
    excludedFromAnalysis: undefined
  })).sort(compareSourceOrder);

  for (const candidate of sorted) {
    const accKey = accountIdentityKey(candidate);
    const candPage = candidate.rawPageNumber || 0;
    const pageMatched = matchedTargetsByPage.get(candPage) || new Set<number>();
    let matchedIdx = -1;

    for (let i = 0; i < representatives.length; i++) {
      if (pageMatched.has(i)) continue;
      const target = representatives[i];
      if (areTransactionsDuplicate(target, candidate)) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== -1) {
      const target = representatives[matchedIdx];
      result.push({
        ...candidate,
        duplicateOfTransactionId: target.id,
        excludedFromAnalysis: true
      });
      pageMatched.add(matchedIdx);
      matchedTargetsByPage.set(candPage, pageMatched);

      if (candidate.rawPageNumber) {
        const pages = mergedPagesByAccount.get(accKey) || new Set<number>();
        pages.add(candidate.rawPageNumber);
        mergedPagesByAccount.set(accKey, pages);
      }
    } else {
      const representative = { ...candidate };
      representatives.push(representative);
      result.push(representative);
    }
  }

  return { transactions: result, mergedPagesByAccount };
}

function areTransactionsDuplicate(a: StandardTransaction, b: StandardTransaction): boolean {
  if ((isEvidenceOnly(a) || isEvidenceOnly(b)) && a.rawPageNumber === b.rawPageNumber && sameSource(a, b)) return false;
  if (a.sourceDocumentId && b.sourceDocumentId && a.sourceDocumentId !== b.sourceDocumentId) return false;
  if ((!a.sourceDocumentId || !b.sourceDocumentId) && a.rawSourceFile !== b.rawSourceFile) return false;
  // 1. Account matching
  const accA = normalizeAccountIdentityPart(a.accountNumber);
  const accB = normalizeAccountIdentityPart(b.accountNumber);
  if (accA && accB && accA !== accB) return false;

  // 2. Date matching (YYYY-MM-DD)
  const dateA = (a.transactionDate || '').slice(0, 10);
  const dateB = (b.transactionDate || '').slice(0, 10);
  if (!dateA || !dateB || dateA !== dateB) return false;

  // 3. Direction matching
  if (a.direction !== 'UNKNOWN' && b.direction !== 'UNKNOWN' && a.direction !== b.direction) {
    return false;
  }

  // 4. Amount matching
  if (Math.abs(a.amount - b.amount) >= 0.01) {
    return false;
  }

  // 5. Time-of-day compatibility
  const timeA = extractTimeOfDay(a.transactionTime);
  const timeB = extractTimeOfDay(b.transactionTime);
  if (timeA && timeB && !timesCompatible(timeA, timeB)) {
    return false;
  }

  // 6. Balance checking
  const hasBalA = a.balanceAvailable !== false && a.balance != null;
  const hasBalB = b.balanceAvailable !== false && b.balance != null;

  if (hasBalA && hasBalB) {
    if (Math.abs(a.balance - b.balance) >= 0.01) {
      return false;
    }

    // Both have identical balance, date, direction, amount, and compatible time
    if (a.rawPageNumber && b.rawPageNumber && a.rawPageNumber !== b.rawPageNumber) {
      // Exact owner/date/direction/nonzero amount/balance across two printed
      // pages is stronger than wording, which often changes across reprints.
      if (isEvidenceOnly(a) && isEvidenceOnly(b) && isReliableAccountNumber(accA)
        && accA === accB && a.amount > 0 && a.direction !== 'UNKNOWN' && a.direction === b.direction) return true;
      const sA = cleanSummaryForMatch(a.summary);
      const sB = cleanSummaryForMatch(b.summary);
      const cpA = cleanSummaryForMatch(a.counterpartyName);
      const cpB = cleanSummaryForMatch(b.counterpartyName);
      const pageDiff = Math.abs(a.rawPageNumber - b.rawPageNumber);

      // 1. If both have granular time, they must match
      if (timeA && timeB) {
        return timeA === timeB;
      }

      // 2. If both have non-empty summary, they must match/overlap
      if (sA && sB) {
        return sA.includes(sB) || sB.includes(sA);
      }

      // 3. If non-adjacent pages (|pageDiff| >= 2, e.g. cross-template reprints like Page 4 vs Page 13)
      if (pageDiff >= 2) {
        if (cpA && cpB && (cpA.includes(cpB) || cpB.includes(cpA))) {
          return true;
        }
        if (sA || sB) {
          return true;
        }
      }

      // 4. For adjacent pages without time and without summary, do not assume duplicate
      return false;
    }

    // Same page duplicate: require time match or summary match
    const sA = cleanSummaryForMatch(a.summary);
    const sB = cleanSummaryForMatch(b.summary);
    if ((timeA && timeB && timeA === timeB) || (sA && sB && sA === sB) || (!sA && !sB)) {
      return true;
    }
    return false;
  }

  // 7. Balance not available on at least one side
  if (a.rawPageNumber && b.rawPageNumber && a.rawPageNumber === b.rawPageNumber) {
    if (a.rawText && b.rawText && a.rawText === b.rawText) return true;
    return false;
  }

  // Cross-page without balance
  if (timeA && timeB && timeA === timeB && timeA.split(':').length === 3) {
    return true;
  }

  const sA = cleanSummaryForMatch(a.summary);
  const sB = cleanSummaryForMatch(b.summary);
  if (sA && sB && (sA.includes(sB) || sB.includes(sA))) {
    return true;
  }

  const cpA = cleanSummaryForMatch(a.counterpartyName);
  const cpB = cleanSummaryForMatch(b.counterpartyName);
  if (cpA && cpB && (cpA.includes(cpB) || cpB.includes(cpA))) {
    return true;
  }

  return false;
}

function extractTimeOfDay(timeStr?: string): string {
  if (!timeStr) return '';
  const trimmed = timeStr.trim();
  const match = trimmed.match(/(\d{2}:\d{2}(?::\d{2})?)/);
  if (match) {
    return match[1];
  }
  return '';
}

function timesCompatible(t1: string, t2: string): boolean {
  if (!t1 || !t2) return true;
  const parts1 = t1.split(':');
  const parts2 = t2.split(':');
  if (parts1[0] !== parts2[0]) return false;
  if (parts1[1] !== parts2[1]) return false;
  if (parts1[2] !== undefined && parts2[2] !== undefined) {
    return parts1[2] === parts2[2];
  }
  return true;
}

function cleanSummaryForMatch(str?: string): string {
  if (!str) return '';
  return str.replace(/[\s\-_@#*|/\\.,:;，。、：；]/g, '').trim().toLowerCase();
}

export function calibrateDirectionsByBalanceMath(transactions: StandardTransaction[]): StandardTransaction[] {
  const byAccount = new Map<string, StandardTransaction[]>();
  for (const tx of transactions) {
    const key = accountIdentityKey(tx);
    byAccount.set(key, [...(byAccount.get(key) || []), tx]);
  }

  for (const [, accTxs] of byAccount) {
    const sourceOrdered = [...accTxs].sort(compareSourceOrder);
    let forwardDatePairs = 0;
    let reverseDatePairs = 0;
    for (let i = 1; i < sourceOrdered.length; i++) {
      const prevDate = (sourceOrdered[i - 1].transactionDate || '').trim();
      const currDate = (sourceOrdered[i].transactionDate || '').trim();
      if (prevDate && currDate && prevDate !== currDate) {
        if (prevDate < currDate) forwardDatePairs++;
        else if (prevDate > currDate) reverseDatePairs++;
      }
    }
    const isReverseStatement = reverseDatePairs > forwardDatePairs && reverseDatePairs >= 1;
    const physicalChronological = isReverseStatement ? [...sourceOrdered].reverse() : sourceOrdered;

    for (let i = 1; i < physicalChronological.length; i++) {
      const prev = physicalChronological[i - 1];
      const curr = physicalChronological[i];

      if (
        prev.balanceAvailable === false ||
        curr.balanceAvailable === false ||
        prev.balance == null ||
        curr.balance == null ||
        curr.amount <= 0
      ) {
        continue;
      }

      const diffIn = Math.abs(prev.balance + curr.amount - curr.balance);
      const diffOut = Math.abs(prev.balance - curr.amount - curr.balance);

      if (diffIn < 0.05 && diffOut >= 0.05 && curr.direction !== 'IN') {
        recordCorrection(curr, '系统依据相邻余额关系修正收支方向');
        curr.direction = 'IN';
        if (curr.reviewStatus === 'AUTO_PASSED') {
          curr.reviewStatus = 'CORRECTED';
        }
      } else if (diffOut < 0.05 && diffIn >= 0.05 && curr.direction !== 'OUT') {
        recordCorrection(curr, '系统依据相邻余额关系修正收支方向');
        curr.direction = 'OUT';
        if (curr.reviewStatus === 'AUTO_PASSED') {
          curr.reviewStatus = 'CORRECTED';
        }
      }
    }
  }

  return transactions;
}

/**
 * Mathematically heals single-transaction OCR digit errors (e.g. faint dot-matrix printer font
 * where '4' was misrecognized as '1', or comma shifts) by reconciling the balance bridge between T_{i-1}, T_i, and T_{i+1}.
 */
export function healOcrBalanceAndAmountDiscrepancies(transactions: StandardTransaction[]): StandardTransaction[] {
  const byAccount = new Map<string, StandardTransaction[]>();
  for (const tx of transactions) {
    const key = accountIdentityKey(tx);
    byAccount.set(key, [...(byAccount.get(key) || []), tx]);
  }

  for (const [, accTxs] of byAccount) {
    if (accTxs.length < 2) continue;
    if (isCreditCardStatement(accTxs)) continue;

    const ordered = chronologicalTransactions(accTxs);

    // Pass 1: Bridge healing across three consecutive transactions (T_{i-1}, T_i, T_{i+1})
    // Where T_i has OCR digit misreads in amount and/or balance, but T_{i-1} and T_{i+1} have solid balances.
    for (let i = 1; i < ordered.length - 1; i++) {
      const prev = ordered[i - 1];
      const curr = ordered[i];
      const next = ordered[i + 1];

      if (
        prev.balanceAvailable === false || curr.balanceAvailable === false || next.balanceAvailable === false ||
        prev.balance == null || curr.balance == null || next.balance == null ||
        curr.direction === 'UNKNOWN' || next.direction === 'UNKNOWN'
      ) {
        continue;
      }

      // Check current discontinuity around curr
      const deltaCurr = curr.direction === 'IN' ? curr.amount : -curr.amount;
      const errPrevCurr = Math.abs(prev.balance + deltaCurr - curr.balance);

      const deltaNext = next.direction === 'IN' ? next.amount : -next.amount;
      const errCurrNext = Math.abs(curr.balance + deltaNext - next.balance);

      // If there is a break around curr (either before or after)
      if (errPrevCurr >= 0.5 || errCurrNext >= 0.5) {
        // Implied balance of curr deduced from next
        const impliedBalCurr = Math.round((next.direction === 'OUT' ? next.balance + next.amount : next.balance - next.amount) * 100) / 100;
        // Implied amount of curr deduced from prev and impliedBalCurr
        const impliedAmtCurr = Math.round(Math.abs(curr.direction === 'IN' ? impliedBalCurr - prev.balance : prev.balance - impliedBalCurr) * 100) / 100;

        // Verify that this implied state is directionally consistent and positive
        const impliedDelta = curr.direction === 'IN' ? impliedAmtCurr : -impliedAmtCurr;
        const testErrPrev = Math.abs(prev.balance + impliedDelta - impliedBalCurr);
        const testErrNext = Math.abs(impliedBalCurr + deltaNext - next.balance);

        if (testErrPrev < 0.05 && testErrNext < 0.05 && impliedAmtCurr > 0) {
          const currAmtStr = curr.amount.toFixed(2);
          const impliedAmtStr = impliedAmtCurr.toFixed(2);
          const currBalStr = curr.balance.toFixed(2);
          const impliedBalStr = impliedBalCurr.toFixed(2);

          const isAmtPlausible =
            curr.amount === impliedAmtCurr ||
            isOcrDigitVariant(currAmtStr, impliedAmtStr) ||
            (curr.rawText && (curr.rawText.includes(impliedAmtStr) || curr.rawText.includes(String(impliedAmtCurr)))) ||
            (curr.summary && (curr.summary.includes(impliedAmtStr) || curr.summary.includes(String(impliedAmtCurr))));

          const isBalPlausible =
            curr.balance === impliedBalCurr ||
            isOcrDigitVariant(currBalStr, impliedBalStr);

          if (isAmtPlausible && isBalPlausible) {
            recordCorrection(curr, '系统依据前后余额桥接关系提出金额及余额修正');
            curr.amount = impliedAmtCurr;
            curr.balance = impliedBalCurr;
          }
        }
      }
    }

    // Pass 2: Two-transaction balance or amount healing (T_{i-1} and T_i)
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const curr = ordered[i];

      if (
        prev.balanceAvailable === false || curr.balanceAvailable === false ||
        prev.balance == null || curr.balance == null ||
        curr.direction === 'UNKNOWN'
      ) {
        continue;
      }

      const delta = curr.direction === 'IN' ? curr.amount : -curr.amount;
      const diff = Math.abs(prev.balance + delta - curr.balance);

      if (diff >= 0.5) {
        const impliedAmt = Math.round(Math.abs(curr.direction === 'IN' ? curr.balance - prev.balance : prev.balance - curr.balance) * 100) / 100;
        if (impliedAmt > 0) {
          const impliedStr = impliedAmt.toFixed(2);
          const currAmtStr = curr.amount.toFixed(2);
          const transactionText = `${curr.summary || ''} ${curr.counterpartyName || ''} ${curr.rawText || ''}`;
          const isAccountClosureSettlement = curr.direction === 'OUT'
            && /销户|清户|销账|结清|冻结扣划|司法扣划|司法划扣|法院扣划|法院划扣/.test(transactionText)
            && impliedAmt >= curr.amount
            && diff >= 1;

          if (
            isOcrDigitVariant(currAmtStr, impliedStr) ||
            (curr.rawText && (curr.rawText.includes(impliedStr) || curr.rawText.includes(String(impliedAmt)))) ||
            (curr.summary && (curr.summary.includes(impliedStr) || curr.summary.includes(String(impliedAmt)))) ||
            isAccountClosureSettlement
          ) {
            recordCorrection(curr, '系统依据相邻余额关系提出金额修正');
            curr.amount = impliedAmt;
            if (curr.reviewStatus === 'AUTO_PASSED') {
              curr.reviewStatus = 'CORRECTED';
            }
          }
        }
      }
    }
  }

  return transactions;
}

function isOcrDigitVariant(strA: string, strB: string): boolean {
  if (strA === strB) return true;
  if (Math.abs(strA.length - strB.length) > 1) return false;
  if (strA.length === strB.length) {
    let diffCount = 0;
    for (let i = 0; i < strA.length; i++) {
      if (strA[i] !== strB[i]) {
        diffCount++;
      }
    }
    if (diffCount <= 1) return true;
  }
  return false;
}

function recordCorrection(transaction: StandardTransaction, reason: string): void {
  if (transaction.originalAmount === undefined) transaction.originalAmount = transaction.amount;
  if (transaction.originalBalance === undefined && transaction.balance != null) transaction.originalBalance = transaction.balance;
  if (transaction.originalDirection === undefined) transaction.originalDirection = transaction.direction;
  transaction.correctionReason = transaction.correctionReason
    ? `${transaction.correctionReason}；${reason}`
    : reason;
  transaction.reviewStatus = 'CORRECTED';
}

function refreshFieldEvidence(transaction: StandardTransaction): void {
  if (!transaction.fieldEvidence) return;
  const reason = transaction.correctionReason;
  update('accountNumber', transaction.accountNumber);
  update('transactionTime', transaction.transactionTime);
  update('direction', transaction.direction, transaction.originalDirection);
  update('amount', transaction.amount, transaction.originalAmount);
  update('balance', transaction.balance, transaction.originalBalance);
  update('counterpartyName', transaction.counterpartyName);
  update('counterpartyAccount', transaction.counterpartyAccount || '');
  update('summary', transaction.summary);

  function update(
    field: keyof NonNullable<StandardTransaction['fieldEvidence']>,
    currentValue: string | number | null,
    explicitOriginal?: string | number | null
  ): void {
    const existing = transaction.fieldEvidence?.[field];
    if (!existing) return;
    const originalValue = explicitOriginal !== undefined ? explicitOriginal : existing.originalValue;
    const changed = String(originalValue ?? '') !== String(currentValue ?? '');
    transaction.fieldEvidence![field] = changed ? {
      ...existing,
      originalValue,
      currentValue,
      origin: 'AUTO_NORMALIZATION',
      decision: transaction.reviewedBy === '律师人工核对' ? 'CONFIRMED' : 'SUGGESTED',
      reason
    } : {
      ...existing,
      currentValue
    };
  }
}
