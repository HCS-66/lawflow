import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';
import { summaryForCounterparty } from '../counterpartyIdentity';

export class Rule06_AffiliatedCompanyTransfer extends BaseRule {
  readonly ruleId = 'RULE_AFFILIATED_COMPANY_TRANSFER';
  readonly name = '已标注关联企业资金往来';
  readonly category: RuleCategory = 'PIERCING_CLUE';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '对律师已确认或标注的关联企业资金往来进行汇总，提示核查合同、发票、账册及财产独立性。';
  readonly statutoryBasis = [
    '《公司法》第23条（一人有限责任公司财产混同举证责任倒置）',
    '《最高人民法院关于民事执行中变更、追加当事人若干问题的规定》第20条',
    '《民法典》第538条'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];

    context.allTransactions.forEach(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return;
      if (tx.amount < 20000) return;

      const cpName = tx.counterpartyName?.trim() || '';
      const cpSummary = summaryForCounterparty(tx, context.counterpartySummaries);
      const isAffiliate = cpSummary?.roleTag?.includes('关联') || cpSummary?.roleTag?.includes('独资');

      if (isAffiliate && /货款|服务费|借款|往来|工程款/.test(tx.summary || '')) {
        matches.push({
          matchId: `${this.ruleId}_${tx.id}`,
          ruleId: this.ruleId,
          ruleName: this.name,
          category: this.category,
          severity: 'L1',
          matchType: 'SINGLE',
          transactionIds: [tx.id],
          totalAmount: tx.amount,
          timePhase: tx.timePhaseTag || '执行关联期间',
          counterpartyName: cpName,
          aiReasoning: `被执行人于 ${tx.transactionDate} 向律师已标注的关联企业【${cpName}】转款 ¥${tx.amount.toLocaleString()} 元（附言：${tx.summary}）。该笔往来需要结合合同、发票、公司账册、纳税资料及实际履行情况核实；单笔账户往来不足以证明无真实交易、抽逃出资或财产混同。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: false
        });
      }
    });

    return matches;
  }
}
