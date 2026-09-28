import { BankAccount, EvidenceReviewIssue, StandardTransaction } from '../types/transaction';
import { transactionBelongsToAccount, isReliableAccountNumber } from '../utils/accountIdentity';
import { balanceContinuityIssues, daysBetween, isBalanceConfirmedZeroSettlement, isCreditCardStatement, isFeeWaiver } from '../utils/transactionSequence';
import { isEvidenceOnly } from '../recognition/decisionPolicy';
import { candidateReviewDescription, candidateReviewTitle, hasPendingCandidateReview } from './candidateReview';

export function buildEvidenceReviewIssues(
  account: BankAccount,
  allTransactions: StandardTransaction[]
): EvidenceReviewIssue[] {
  const observations = allTransactions.filter(transaction => transactionBelongsToAccount(transaction, account));
  const transactions = observations
    .filter(transaction => !transaction.excludedFromAnalysis)
    .sort(compareSourceOrder);
  const generated: EvidenceReviewIssue[] = [];
  const unscopedWarnings: string[] = [];

  for (const warning of account.parseWarnings || []) {
    if (isLegacyDerivedWarning(warning)) continue;
    let pageNumber = numberFrom(warning, /第\s*(\d+)\s*页/) || numberFrom(warning, /原PDF第\s*(\d+)\s*页/);
    const isPlanningNotice = /账单分组提示：/.test(warning);
    const isOwnerContinuation = /系统未据此改写流水账号/.test(warning);
    if (pageNumber && (isPlanningNotice || isOwnerContinuation)) {
      const affected = transactions.filter(row => row.rawPageNumber === pageNumber && !isReliableAccountNumber(row.accountNumber));
      if (isOwnerContinuation && !affected.length) continue;
      generated.push({
        id: stableIssueId(`${account.accountNumber}|statement|${warning}`), category: 'DATA_WARNING',
        severity: isOwnerContinuation ? 'REQUIRED' : 'ADVISORY',
        title: `第 ${pageNumber} 页${isOwnerContinuation ? '确认流水所属账号' : '分组参考不可用'}`,
        description: warning,
        instructions: isOwnerContinuation
          ? ['同时打开本页和提示中的参考页', '核对本方账号、表头和连续打印页码，确认是否同一账单', '只有归属明确后才填写相关流水的本方账号；不要仅凭相邻页判断']
          : ['本页已独立识别，不需要仅因分组提示修改金额或日期', '若本方账号不明确，再对照原件确认归属'],
        pageNumber, transactionIds: isOwnerContinuation ? affected.map(row => row.id) : [], status: 'PENDING'
      });
      continue;
    }
    const isBankIdentityNotice = /银行名称.*(?:原文依据|不一致)/.test(warning);
    const isBlank = !isBankIdentityNotice && /空白|扫描残页|未识别到交易/.test(warning);
    const countComparison = parseCountComparison(warning);
    const isIntegrity = !isBankIdentityNotice && (Boolean(countComparison)
      || /汇总|缺少|漏|不完整|页面覆盖|识别失败|独立清点|独立行数复核|页面行数报告|请清点原件行数/.test(warning));
    if (!pageNumber && countComparison) pageNumber = inferUniquePageByCount(transactions, countComparison.detailCount);
    if (!pageNumber) {
      unscopedWarnings.push(warning);
      continue;
    }
    generated.push({
      id: stableIssueId(countComparison
        ? `${account.accountNumber}|count|${pageNumber}|${countComparison.summaryCount}|${countComparison.detailCount}`
        : `${account.accountNumber}|warning|${warning}`),
      category: isBlank ? 'BLANK_PAGE' : isIntegrity ? 'PAGE_INTEGRITY' : 'DATA_WARNING',
      severity: isBlank || isIntegrity ? 'REQUIRED' : 'ADVISORY',
      title: isBlank ? `第 ${pageNumber || '?'} 页疑似空白` : countComparison ? `第 ${pageNumber || '?'} 页两次计数不一致（${countComparison.summaryCount} / ${countComparison.detailCount}）` : isIntegrity ? `第 ${pageNumber || '?'} 页完整性核对` : '解析结果核对',
      description: countComparison
        ? `系统一次页面计数为 ${countComparison.summaryCount} 笔，逐笔提取为 ${countComparison.detailCount} 笔；两者均尚未经过律师确认，应以原始页面实际交易行数为准。`
        : warning,
      instructions: isBlank
        ? ['查看完整原始页面', '确认该页是否确实没有交易明细', '如存在交易，请补录遗漏记录']
        : isIntegrity
        ? countComparison
          ? [`直接清点原始页面实际交易行数`, `如原件为 ${countComparison.detailCount} 笔，确认保留全部明细`, `如原件少于 ${countComparison.detailCount} 笔，勾选并删除重复或误识别记录`, `如原件更多，补录遗漏记录`]
          : ['核对该页实际交易行数', '检查日期是否跳跃及余额是否无法衔接', '发现漏行时按原件补录']
        : ['对照原件核实提示内容', '记录确认结果或无法确认的原因'],
      pageNumber,
      transactionIds: pageNumber ? transactions.filter(transaction => transaction.rawPageNumber === pageNumber).map(transaction => transaction.id) : [],
      status: 'PENDING'
    });
  }

  if (unscopedWarnings.length) {
    const unique = [...new Set(unscopedWarnings)];
    generated.push({
      id: stableIssueId(`${account.accountNumber}|unscoped|${unique.join('|')}`),
      category: 'DATA_WARNING', severity: 'ADVISORY', title: `文件级读取提示（${unique.length} 条）`,
      description: unique.slice(0, 8).join('；') + (unique.length > 8 ? `；另有 ${unique.length - 8} 条提示` : ''),
      instructions: ['结合原始文件整体浏览', '如提示影响交易明细，再定位相关页面处理'],
      transactionIds: [], status: 'PENDING'
    });
  }

  // Deduplication controls counting, not whether source identity/field doubts
  // have been reviewed. Otherwise merging an account could hide its own task.
  for (const row of observations.filter(hasPendingCandidateReview)) {
    generated.push({ id: stableIssueId(`${account.accountNumber}|candidate|${row.id}`),
      category: 'CANDIDATE_CONFLICT', severity: 'REQUIRED',
      title: `第 ${row.rawPageNumber || '?'} 页第 ${row.rawRowIndex || '?'} 行：${candidateReviewTitle(row)}`,
      description: candidateReviewDescription(row), instructions: ['找到原件对应行', '按列出的差异核对并填写原件值，不以余额推算值代替原件'],
      pageNumber: row.rawPageNumber, transactionIds: [row.id], status: 'PENDING' });
  }
  appendTransactionIssueGroup(generated, account, transactions, 'LOW_CONFIDENCE',
    transaction => (transaction.extractionConfidence ?? 1) < 0.8
      || (!isEvidenceOnly(transaction) && transaction.reviewStatus === 'CORRECTED' && transaction.reviewedBy !== '律师人工核对'),
    '识别或自动修正结果待核对', '本页有交易字段读取把握较低，或系统曾依据余额关系提出自动修正，需与原件逐字段核对。',
    ['核对交易日期和收支方向', '核对金额及交易后余额', '核对对手方和摘要']);
  appendTransactionIssueGroup(generated, account, transactions, 'INVALID_AMOUNT',
    transaction => isEvidenceOnly(transaction)
      ? Boolean(transaction.dataQualityIssues?.includes('INVALID_AMOUNT')) || transaction.amount < 0
      : (transaction.amount <= 0 || Boolean(transaction.dataQualityIssues?.includes('INVALID_AMOUNT')))
        && !isFeeWaiver(transaction) && !isBalanceConfirmedZeroSettlement(transaction, transactions),
    '交易金额异常', '本页有交易金额为零或未能可靠读取。',
    ['核对原件发生额', '确认相关行是否属于交易明细', '修正金额或说明无法确认的原因']);
  appendTransactionIssueGroup(generated, account, transactions, 'INVALID_DATE',
    transaction => !transaction.transactionDate || Boolean(transaction.dataQualityIssues?.includes('INVALID_DATE')),
    '交易日期待核对', '本页有交易日期未能可靠读取。',
    ['对照原件补全交易日期和时间', '确认相关行确属于交易明细']);
  appendTransactionIssueGroup(generated, account, transactions, 'INVALID_DIRECTION',
    transaction => transaction.direction === 'UNKNOWN' || Boolean(transaction.dataQualityIssues?.includes('UNKNOWN_DIRECTION')),
    '收支方向待核对', '本页有交易的收入或支出方向尚未确认，目前不计入资金流向汇总。',
    ['核对原件借贷标识或收支栏', '确认为收入或支出并保存']);

  const balanceByPage = new Map<number, ReturnType<typeof balanceContinuityIssues>>();
  const balanceIssues = isCreditCardStatement(transactions, account.bankName) ? [] : balanceContinuityIssues(transactions);
  for (const issue of balanceIssues) {
    const page = issue.transaction.rawPageNumber || 0;
    balanceByPage.set(page, [...(balanceByPage.get(page) || []), issue]);
  }
  for (const [pageNumber, pageIssues] of balanceByPage) {
    // One isolated mismatch across a long period is a statement-range gap, not
    // enough evidence to classify the whole page as a periodic statement.
    if (pageIssues.length === 1 && pageIssues[0].isLongInterval) continue;
    const transactionIds = [...new Set(pageIssues.flatMap(({ previous, transaction }) => [previous.id, transaction.id]))];
    const pageTransactions = transactions.filter(t => (t.rawPageNumber || 0) === pageNumber);

    const longIntervalCount = pageIssues.filter(i => i.isLongInterval).length;

    // Check 1: Monthly or periodic intervals (>= 20 days or cross-month transitions)
    const crossMonthCount = pageIssues.filter(i => {
      const prevD = (i.previous.transactionDate || '').slice(0, 7);
      const currD = (i.transaction.transactionDate || '').slice(0, 7);
      return i.isLongInterval || (prevD && currD && prevD !== currD) || (i.daysApart != null && i.daysApart >= 20);
    }).length;

    // Check 2: Periodic settlement descriptions (利息, 年费, 还款, 代扣, 分期, 违约金, 减免)
    const isPeriodicDesc = (tx: StandardTransaction) =>
      /结息|利息|年费|还款|代扣|分期|违约金|滞纳金|减免/.test(tx.summary || tx.counterpartyName || '');
    const periodicIssueCount = pageIssues.filter(i => isPeriodicDesc(i.transaction) || isPeriodicDesc(i.previous)).length;
    const isPeriodicDominant = periodicIssueCount >= Math.ceil(pageIssues.length * 0.5) ||
      (pageTransactions.length > 0 && pageTransactions.filter(isPeriodicDesc).length >= Math.ceil(pageTransactions.length * 0.5));

    // Check 3: Page time density (average days per transaction on page)
    const dates = pageTransactions.map(t => t.transactionDate).filter(Boolean).sort() as string[];
    const pageSpanDays = dates.length >= 2 ? daysBetween(dates[0], dates[dates.length - 1]) : 0;
    const isSparseStatement = dates.length >= 2 && pageSpanDays >= 45 && (pageSpanDays / dates.length) >= 10;

    // Check 4: Credit card negative / overdraft balances
    const isCreditCardOverdraft = pageTransactions.some(t => t.balance != null && t.balance < 0);

    const isMainlyDiscrete =
      longIntervalCount >= Math.ceil(pageIssues.length / 2) ||
      crossMonthCount >= Math.ceil(pageIssues.length / 2) ||
      (isPeriodicDominant && (isSparseStatement || crossMonthCount > 0 || isCreditCardOverdraft)) ||
      (isSparseStatement && isCreditCardOverdraft);

    if (isMainlyDiscrete) {
      generated.push({
        id: stableIssueId(`${account.accountNumber}|discrete_statement|${pageNumber}|${transactionIds.join('|')}`),
        category: 'DATA_WARNING', severity: 'ADVISORY',
        title: `第 ${pageNumber || '?'} 页包含跨期离散账单（${pageIssues.length} 处跨月间隔）`,
        description: `本页流水记账时间跨度较大（记账间隔普遍超过 30 天），多见于利息结计、年费减免、分期代扣或跨月汇总表。建议结合关联消费卡日常流水综合核对。`,
        instructions: ['确认该页是否属于非逐日利息/还款汇总表', '如无遗漏交易行，可直接标记为已确认', '如存在关联日常消费卡，对照核验总体收支'],
        pageNumber: pageNumber || undefined,
        transactionIds, status: 'PENDING'
      });
    } else {
      generated.push({
        id: stableIssueId(`${account.accountNumber}|balance|${pageNumber}|${transactionIds.join('|')}`),
        category: 'BALANCE_BREAK', severity: 'REQUIRED',
        title: `第 ${pageNumber || '?'} 页余额不连续（${pageIssues.length} 处）`,
        description: `本页有 ${pageIssues.length} 处余额无法与相邻交易直接衔接，可能存在字段误读、漏行或跨账户分页。`,
        instructions: ['同时核对当前笔与上一笔', '确认金额、方向和余额是否识别正确', '检查两笔之间是否存在漏行'],
        pageNumber: pageNumber || undefined,
        transactionIds, status: 'PENDING'
      });
    }
  }

  const generatedIds = new Set(generated.map(issue => issue.id));
  for (const saved of account.reviewIssues || []) {
    if (!generatedIds.has(saved.id) && (saved.status === 'PENDING' || saved.status === 'UNRESOLVED')) {
      generated.push(saved);
    }
  }
  const existing = new Map((account.reviewIssues || []).map(issue => [issue.id, issue]));
  return deduplicate(generated).map(issue => {
    const saved = existing.get(issue.id);
    return saved ? { ...issue, status: saved.status, resolutionNote: saved.resolutionNote, reviewedAt: saved.reviewedAt } : issue;
  });
}

function appendTransactionIssueGroup(
  target: EvidenceReviewIssue[], account: BankAccount, transactions: StandardTransaction[],
  category: EvidenceReviewIssue['category'], matches: (transaction: StandardTransaction) => boolean,
  title: string, description: string, instructions: string[]
): void {
  const groups = groupByPage(transactions.filter(matches));
  for (const [pageNumber, affected] of groups) {
    target.push({
      id: stableIssueId(`${account.accountNumber}|${category}|${pageNumber}|${affected.map(item => item.id).join('|')}`),
      category, severity: 'REQUIRED',
      title: `第 ${pageNumber || '?'} 页${title}（${affected.length} 笔）`, description, instructions,
      pageNumber: pageNumber || undefined, transactionIds: affected.map(item => item.id), status: 'PENDING'
    });
  }
}

function groupByPage<T extends { rawPageNumber?: number }>(items: T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const page = item.rawPageNumber || 0;
    groups.set(page, [...(groups.get(page) || []), item]);
  }
  return groups;
}

function isLegacyDerivedWarning(warning: string): boolean {
  return /第\s*\d+\s*页第\s*\d+\s*笔交易余额不连续/.test(warning)
    || /识别置信度低于\s*80%/.test(warning)
    || /第\s*\d+\s*页第\s*\d+\s*笔(?:收支方向|交易金额)无法确认/.test(warning);
}

function deduplicate(issues: EvidenceReviewIssue[]): EvidenceReviewIssue[] {
  return [...new Map(issues.map(issue => [issue.id, issue])).values()];
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}

function numberFrom(value: string, pattern: RegExp): number | undefined {
  const match = value.match(pattern);
  return match ? Number(match[1]) : undefined;
}

function parseCountComparison(value: string): { summaryCount: number; detailCount: number } | undefined {
  const match = value.match(/页面汇总为\s*(\d+)\s*笔.*?(?:当前)?逐笔明细(?:实际)?(?:为|仅有)\s*(\d+)\s*笔/)
    || value.match(/页面汇总为\s*(\d+)\s*笔.*?自动复核后最多识别\s*(\d+)\s*笔/)
    || value.match(/页面计数为\s*(\d+)\s*笔.*?逐笔提取为\s*(\d+)\s*笔/)
    || value.match(/独立清点为\s*(\d+)\s*笔.*?逐笔明细为\s*(\d+)\s*笔/);
  return match ? { summaryCount: Number(match[1]), detailCount: Number(match[2]) } : undefined;
}

function inferUniquePageByCount(transactions: StandardTransaction[], detailCount: number): number | undefined {
  const counts = new Map<number, number>();
  for (const transaction of transactions) {
    if (!transaction.rawPageNumber) continue;
    counts.set(transaction.rawPageNumber, (counts.get(transaction.rawPageNumber) || 0) + 1);
  }
  const candidates = [...counts.entries()].filter(([, count]) => count === detailCount).map(([page]) => page);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function stableIssueId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `REVIEW_${(hash >>> 0).toString(36).toUpperCase()}`;
}
