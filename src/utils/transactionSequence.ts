import { StandardTransaction } from '../types/transaction';

export interface BalanceContinuityIssue {
  previous: StandardTransaction;
  transaction: StandardTransaction;
  expected: number;
  daysApart?: number;
  isLongInterval?: boolean;
}

/**
 * Detects whether a zero-amount transaction is a legitimate bank fee waiver or exemption record
 * (e.g. 减免年费, 减免费用, 年费减免, 免收年费) rather than an invalid or missing amount.
 */
export function isFeeWaiver(transaction: StandardTransaction): boolean {
  if (transaction.transactionType === '费用减免') return true;
  const text = `${transaction.summary || ''} ${transaction.counterpartyName || ''} ${transaction.rawText || ''}`;
  return /减免|免收|豁免|优惠|抵扣/.test(text);
}

/**
 * Some bank ledgers print scheduled interest-settlement rows with an actual
 * amount of 0.00. Treat them as valid only when an adjacent physical row for
 * the same account has the same balance; this avoids accepting a missed amount
 * merely because the summary contains “结息”.
 */
export function isBalanceConfirmedZeroSettlement(
  transaction: StandardTransaction,
  accountTransactions: StandardTransaction[]
): boolean {
  if (transaction.amount !== 0) return false;
  if (isFeeWaiver(transaction)) return true;
  const text = `${transaction.transactionType || ''} ${transaction.summary || ''} ${transaction.counterpartyName || ''} ${transaction.rawText || ''}`;
  if (!/结息|利息结算|计息/.test(text)) return false;
  if (transaction.balanceAvailable === false || transaction.balance == null) return false;

  const sameAccount = accountTransactions
    .filter(item => normalizedAccount(item.accountNumber) === normalizedAccount(transaction.accountNumber))
    .sort(compareSourceOrder);
  const index = sameAccount.findIndex(item => item.id === transaction.id);
  if (index < 0) return false;
  return [sameAccount[index - 1], sameAccount[index + 1]].some(neighbor => (
    neighbor
    && neighbor.balanceAvailable !== false
    && neighbor.balance != null
    && Math.abs(neighbor.balance - transaction.balance) < 0.005
  ));
}

function normalizedAccount(value: string): string {
  return String(value || '').replace(/[\s\-_—–·•]/g, '').toLowerCase();
}

/**
 * Credit-card histories may expose a shared outstanding balance rather than a
 * deposit-account balance that can be audited across every displayed card.
 */
export function isCreditCardStatement(transactions: StandardTransaction[], bankName = ''): boolean {
  if (transactions.length && transactions.every(row => row.sourceAccountKind === 'deposit')) return false;
  if (transactions.length && transactions.every(row => row.sourceAccountKind === 'credit')) return true;
  const text = [bankName, ...transactions.flatMap(transaction => [
    transaction.bankName, transaction.summary, transaction.counterpartyName, transaction.rawText
  ])].filter(Boolean).join(' ');
  if (/信用卡|贷记卡|牡丹卡/.test(text)) return true;

  const withBalance = transactions.filter(transaction => transaction.balanceAvailable !== false && transaction.balance != null);
  const negativeBalances = withBalance.filter(transaction => Number(transaction.balance) < 0).length;
  const creditCardRows = transactions.filter(transaction =>
    ['透支利息', '分期', '分期转换', '分期退款', '违约金'].includes(transaction.transactionType || '')
    || /透支|年费|自动转[账帐]还款|分期付款|消费转分期|分期利息|分期费用/.test(
      `${transaction.summary || ''} ${transaction.counterpartyName || ''} ${transaction.rawText || ''}`
    )
  ).length;
  return withBalance.length > 0
    && negativeBalances >= Math.ceil(withBalance.length / 2)
    && creditCardRows >= Math.min(2, transactions.length);
}

/**
 * Normalizes dates and timestamps into ISO-comparable strings YYYY-MM-DD HH:mm:ss.
 */
export function normalizeTransactionTimestamp(tx: StandardTransaction): string {
  const dateStr = (tx.transactionDate || '').trim();
  const timeStr = (tx.transactionTime || '').trim();

  // Normalize date: support 2023-05-08, 2023/05/08, 20230508
  let formattedDate = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    formattedDate = dateStr;
  } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(dateStr)) {
    formattedDate = dateStr.replace(/\//g, '-');
  } else if (/^\d{8}$/.test(dateStr)) {
    formattedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  } else {
    formattedDate = dateStr || '9999-99-99';
  }

  // Normalize time: HH:mm:ss or HHmmss
  let formattedTime = '';
  if (timeStr.includes(':')) {
    const parts = timeStr.split(' ');
    formattedTime = parts[parts.length - 1];
  } else if (/^\d{6}$/.test(timeStr)) {
    formattedTime = `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}:${timeStr.slice(4, 6)}`;
  } else if (timeStr) {
    formattedTime = timeStr;
  } else {
    formattedTime = '00:00:00';
  }

  return `${formattedDate} ${formattedTime}`.trim();
}

/**
 * Calculates calendar day distance between two dates.
 */
export function daysBetween(d1?: string, d2?: string): number {
  if (!d1 || !d2) return 0;
  const t1 = new Date(d1).getTime();
  const t2 = new Date(d2).getTime();
  if (isNaN(t1) || isNaN(t2)) return 0;
  return Math.abs(Math.round((t2 - t1) / (1000 * 3600 * 24)));
}

/**
 * Truly orders transactions in chronological time order (oldest to newest).
 * Within the same day/timestamp, uses a greedy balance-chain linker to preserve valid balance math.
 * Protects physical printed ledger row order against spurious breaks caused by OCR date typos.
 */
export function chronologicalTransactions(transactions: StandardTransaction[]): StandardTransaction[] {
  if (transactions.length < 2) return [...transactions];

  // 1. Determine physical source chronological order
  const sourceOrdered = [...transactions].sort(compareSourceOrder);
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

  // 2. Group by date
  const dateMap = new Map<string, StandardTransaction[]>();
  for (const tx of transactions) {
    const d = (tx.transactionDate || '').trim() || '9999-99-99';
    const list = dateMap.get(d) || [];
    list.push(tx);
    dateMap.set(d, list);
  }

  // 3. Sort dates in ascending chronological order
  const sortedDates = [...dateMap.keys()].sort((a, b) => a.localeCompare(b));

  const dateOrdered: StandardTransaction[] = [];
  let runningBalance: number | null = null;

  for (const date of sortedDates) {
    const dayTxs = dateMap.get(date)!;
    if (dayTxs.length === 1) {
      dateOrdered.push(dayTxs[0]);
      if (dayTxs[0].balanceAvailable !== false && dayTxs[0].balance != null) {
        runningBalance = dayTxs[0].balance;
      }
      continue;
    }

    // Check if day transactions have timestamps
    const hasTimestamps = dayTxs.some(t => t.transactionTime && t.transactionTime !== t.transactionDate);
    if (hasTimestamps) {
      dayTxs.sort((a, b) => {
        const timeA = normalizeTransactionTimestamp(a);
        const timeB = normalizeTransactionTimestamp(b);
        if (timeA !== timeB) return timeA.localeCompare(timeB);
        return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
      });
      const fScore = continuityErrorScore(dayTxs, runningBalance);
      const rScore = continuityErrorScore([...dayTxs].reverse(), runningBalance);
      const sortedDayTxs = rScore + 0.01 < fScore ? [...dayTxs].reverse() : dayTxs;

      for (const t of sortedDayTxs) {
        dateOrdered.push(t);
        if (t.balanceAvailable !== false && t.balance != null) runningBalance = t.balance;
      }
      continue;
    }

    // No granular timestamps: Attempt same-day balance chain solver
    const solved = solveSameDayBalanceChain(dayTxs, runningBalance);
    for (const t of solved) {
      dateOrdered.push(t);
      if (t.balanceAvailable !== false && t.balance != null) runningBalance = t.balance;
    }
  }

  // 4. Compare balance continuity between physical ledger order and date-sorted order.
  // Physical bank statement order represents the authoritative printed sequence.
  // If date-sorting creates more balance breaks than physical order (often due to OCR date typos),
  // physical order must be preferred to prevent cascading false continuity alerts.
  const physicalErrors = countOrderDiscontinuities(physicalChronological);
  const dateErrors = countOrderDiscontinuities(dateOrdered);

  if (
    physicalErrors.broken < dateErrors.broken ||
    (physicalErrors.valid > 0 && physicalErrors.broken === 0 && dateErrors.broken > 0)
  ) {
    return physicalChronological;
  }

  return dateOrdered;
}

function countOrderDiscontinuities(ordered: StandardTransaction[]): { valid: number; broken: number } {
  let valid = 0;
  let broken = 0;

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];

    if (
      previous.balanceAvailable === false ||
      current.balanceAvailable === false ||
      current.direction === 'UNKNOWN' ||
      previous.balance == null ||
      current.balance == null
    ) {
      continue;
    }

    const delta = current.direction === 'IN' ? current.amount : -current.amount;
    const expected = previous.balance + delta;
    const diff = Math.abs(expected - current.balance);

    if (diff < 1.0) {
      valid += 1;
    } else {
      broken += 1;
    }
  }

  return { valid, broken };
}

/**
 * Greedily chains same-day transactions by matching expected balance transition.
 */
function solveSameDayBalanceChain(
  txs: StandardTransaction[],
  startBalance: number | null
): StandardTransaction[] {
  if (txs.length <= 1) return txs;

  const forwardScore = continuityErrorScore(txs, startBalance);
  const reversed = [...txs].reverse();
  const reverseScore = continuityErrorScore(reversed, startBalance);

  if (reverseScore + 0.01 < forwardScore) {
    return reversed;
  }
  return txs;
}

/**
 * Evaluates balance continuity and flags genuine discontinuities.
 * Gracefully identifies long-interval gaps (>30 days, such as credit card interest/fee summary tables).
 */
export function balanceContinuityIssues(
  transactions: StandardTransaction[]
): BalanceContinuityIssue[] {
  const ordered = chronologicalTransactions(transactions);
  const issues: BalanceContinuityIssue[] = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];

    if (
      previous.balanceAvailable === false ||
      current.balanceAvailable === false ||
      current.direction === 'UNKNOWN' ||
      previous.balance == null ||
      current.balance == null
    ) {
      continue;
    }

    const days = daysBetween(previous.transactionDate, current.transactionDate);
    const isLongInterval = days > 30;

    const delta = current.direction === 'IN' ? current.amount : -current.amount;
    const expected = previous.balance + delta;

    const diff = Math.abs(expected - current.balance);

    if (Math.round(diff * 100) !== 0) {
      issues.push({
        previous,
        transaction: current,
        expected,
        daysApart: days,
        isLongInterval
      });
    }
  }

  return issues;
}

function continuityErrorScore(ordered: StandardTransaction[], initialBalance: number | null): number {
  let score = 0;
  let comparisons = 0;
  let prevBal = initialBalance;

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (current.balanceAvailable === false || current.direction === 'UNKNOWN' || current.balance == null) {
      continue;
    }
    if (prevBal != null) {
      const delta = current.direction === 'IN' ? current.amount : -current.amount;
      const expected = prevBal + delta;
      score += Math.min(Math.abs(expected - current.balance), 1_000_000);
      comparisons += 1;
    }
    prevBal = current.balance;
  }

  return comparisons ? score / comparisons : 0;
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}
