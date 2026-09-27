import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';
import { summaryForCounterparty } from '../counterpartyIdentity';

export class Rule05_FabricatedRemarksBilateral extends BaseRule {
  readonly ruleId = 'RULE_FABRICATED_REMARKS_BILATERAL';
  readonly name = '“还借款/还款”备注真实性核验';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '提取所有带有“还借款/还款/偿还”等备注的对外转账，要求律师核对基础债权和实际交付证据。';
  readonly statutoryBasis = [
    '《民法典》第538条、第539条',
    '最高法判例（2021）川01民终11323号裁判规则',
    '法释〔2024〕13号第3条'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];

    context.allTransactions.forEach(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return;
      if (tx.amount < 1000) return;

      const isRepaymentRemark = /还款|还借款|归还|偿还|借款归还|还钱/.test(tx.summary || '');
      if (!isRepaymentRemark) return;

      // Check counterparty total incoming from this counterparty
      const cpName = tx.counterpartyName?.trim() || '';
      const cpSummary = summaryForCounterparty(tx, context.counterpartySummaries);

      const totalIn = cpSummary ? cpSummary.totalIn : 0;
      const bilateralCoverage = tx.amount > 0 ? totalIn / tx.amount : 0;
      matches.push({
        matchId: `${this.ruleId}_${tx.id}`,
        ruleId: this.ruleId,
        ruleName: this.name,
        category: this.category,
        severity: bilateralCoverage < 0.3 ? 'L1' : 'L2',
        matchType: 'SINGLE',
        transactionIds: [tx.id],
        totalAmount: tx.amount,
        timePhase: tx.timePhaseTag || '执行关联期间',
        counterpartyName: cpName,
        aiReasoning: `被执行人于 ${tx.transactionDate} 向【${cpName || '未知对手方'}】转出 ¥${tx.amount.toLocaleString()} 元，备注为“${tx.summary}”。当前已导入流水期间内，该对手方向被执行人转入合计 ¥${totalIn.toLocaleString()} 元${bilateralCoverage < 0.3 ? '，暂未发现与本次还款金额相匹配的足额借款交付记录' : '，存在一定双向资金往来，但仍不能仅凭流水确认借款关系和还款真实性'}。该笔交易必须由律师核验基础债权后再判断。`,
        statutoryBasis: this.statutoryBasis,
        lawyerAdopted: false,
        verificationStatus: 'PENDING',
        verificationChecklist: [
          '借款合同、借条或欠条是否真实形成，签署时间是否早于本次还款',
          '出借人是否实际交付借款，核对更早期间及其他账户的转入记录',
          '借款金额、利息、期限与本次还款金额及时间是否对应',
          '对手方与被执行人是否存在亲属、关联企业或其他特殊关系',
          '是否存在还款后回流、代持、提现或继续转往关联方的情形',
          '必要时核对聊天记录、收据、会计账簿、纳税资料及对手方说明'
        ]
      });
    });

    return matches;
  }
}
