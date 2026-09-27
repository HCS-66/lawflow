import { StandardTransaction, CounterpartySummary } from '../types/transaction';
import { counterpartyIdentityKey } from './counterpartyIdentity';

const JUDICIAL_DEDUCTION_PATTERN = /司法划扣|司法扣划|法院划扣|法院扣划|司法扣款|冻结扣划|强制扣划|强制执行扣款|(?:网络)?执行查控.{0,12}(?:扣划|划扣)|网络查控.{0,20}(?:扣划|划扣)/;
const GENERIC_JUDICIAL_COUNTERPARTY_PATTERN = /网络.*查控.*(?:扣划|划扣)|(?:扣划|划扣).*专户/;

export function isJudicialDeduction(tx: StandardTransaction): boolean {
  return tx.direction === 'OUT' && (tx.transactionType === '司法扣划' || JUDICIAL_DEDUCTION_PATTERN.test(`${tx.summary || ''} ${tx.rawText || ''}`));
}

export function effectiveCounterpartyName(tx: StandardTransaction): string {
  const extractedName = tx.counterpartyName?.trim();
  const context = `${tx.transactionType || ''} ${tx.summary || ''} ${tx.rawText || ''}`;
  if (JUDICIAL_DEDUCTION_PATTERN.test(context)
    && (!extractedName || GENERIC_JUDICIAL_COUNTERPARTY_PATTERN.test(extractedName))) return '【司法机关划扣】';
  if (extractedName) return extractedName;
  if (/\bATM\b|现金取款|取现|柜面取款/.test(context)) return '【现金取现】';
  return '【无对手方名称／用途待核对】';
}

/**
 * Aggregates bilateral cash flows per counterparty (total in, total out, net flow)
 * and detects suspected relatives or corporate affiliates.
 */
export function aggregateCounterparties(
  transactions: StandardTransaction[],
  debtorName: string = ''
): Record<string, CounterpartySummary> {
  const map: Record<string, CounterpartySummary> = {};

  const debtorSurname = debtorName ? debtorName.trim().charAt(0) : '';

  transactions.forEach(tx => {
    // Exclude internal transfers from external counterparty analysis
    if (tx.isInternalTransfer) return;

    const rawName = effectiveCounterpartyName(tx);
    const identity = counterpartyIdentityKey(tx, rawName);
    if (!map[identity]) {
      const isSuspectedRel = (
        debtorSurname !== '' && 
        rawName.startsWith(debtorSurname) && 
        rawName.length <= 4 && 
        rawName !== debtorName
      ) || /生活费|赡养|学费|零用钱|配偶|亲属|儿子|女儿|父母/.test(tx.summary || '');

      map[identity] = {
        identityKey: identity, aliases: [], transactionIds: [],
        name: rawName,
        account: tx.counterpartyAccount,
        totalIn: 0,
        totalOut: 0,
        netOut: 0,
        transactionCount: 0,
        earliestDate: tx.transactionDate,
        latestDate: tx.transactionDate,
        frequentSummaries: [],
        roleTag: tx.counterpartyRoleTag,
        isSuspectedRelative: isSuspectedRel,
        // A company suffix only identifies an enterprise counterparty; it is
        // not evidence of an affiliation with the debtor.
        isSuspectedAffiliate: false
      };
    }

    const item = map[identity];
    item.aliases = [...new Set([...(item.aliases || []), rawName])];
    item.transactionIds!.push(tx.id);
    if (tx.counterpartyRoleTag && !item.roleTag) item.roleTag = tx.counterpartyRoleTag;
    item.transactionCount += 1;
    if (tx.direction === 'IN') {
      item.totalIn += tx.amount;
    } else if (tx.direction === 'OUT') {
      item.totalOut += tx.amount;
    }
    item.netOut = item.totalOut - item.totalIn;

    if (tx.transactionDate < item.earliestDate) item.earliestDate = tx.transactionDate;
    if (tx.transactionDate > item.latestDate) item.latestDate = tx.transactionDate;

    if (tx.summary && !item.frequentSummaries.includes(tx.summary) && item.frequentSummaries.length < 5) {
      item.frequentSummaries.push(tx.summary);
    }
  });

  return map;
}
