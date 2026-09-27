import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule03_AntMovingCloseRelatives extends BaseRule {
  readonly ruleId = 'RULE_ANT_MOVING_CLOSE_RELATIVES';
  readonly name = '疑似近亲属高频转账';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '向疑似亲属或特定个人发生多笔转账，提示核实真实关系、用途及是否存在合理对价。';
  readonly statutoryBasis = [
    '《民法典》第538条（无偿处分财产权益的撤销权）',
    '《民法典》第539条（明显不合理低价/高价交易）',
    '法释〔2024〕13号第3条'
  ];

  constructor() {
    super();
    this.params = {
      minCount: 3,
      totalAmountThreshold: 30000
    };
  }

  evaluate(context: RuleContext): AnomalyMatch[] {
    const minCount = Number(this.params.minCount) || 3;
    const totalThreshold = Number(this.params.totalAmountThreshold) || 30000;
    const matches: AnomalyMatch[] = [];

    Object.values(context.counterpartySummaries).forEach(cp => {
      if (!cp.isSuspectedRelative && !cp.roleTag?.includes('亲属') && !cp.roleTag?.includes('配偶')) {
        return;
      }

      if (cp.transactionCount >= minCount && cp.netOut >= totalThreshold) {
        // Collect matching transactions
        const relatedTx = context.allTransactions.filter(
          tx => !tx.isInternalTransfer && (cp.transactionIds ? cp.transactionIds.includes(tx.id) : tx.counterpartyName === cp.name) && tx.direction === 'OUT'
        );

        matches.push({
          matchId: `${this.ruleId}_${cp.identityKey || cp.name}`,
          ruleId: this.ruleId,
          ruleName: this.name,
          category: this.category,
          severity: cp.netOut >= 100000 ? 'L0' : 'L1',
          matchType: 'GROUP',
          transactionIds: relatedTx.map(t => t.id),
          totalAmount: cp.netOut,
          timePhase: '多阶段累计',
          counterpartyName: cp.name,
          aiReasoning: `被执行人向【${cp.name}】发生 ${cp.transactionCount} 笔转账，累计净流出 ¥${cp.netOut.toLocaleString()} 元（平均每笔约 ¥${Math.round(cp.netOut / cp.transactionCount).toLocaleString()} 元）。系统仅依据${cp.roleTag ? `律师标注“${cp.roleTag}”` : '同姓或摘要关键词'}提示可能存在亲属关系；应先核实身份，再结合款项用途、家庭生活需要和对价判断法律意义。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: false
        });
      }
    });

    return matches;
  }
}
