import { semanticText } from './semanticText';

/** Purpose outranks the transfer/payment mechanism. No bank/account/amount-specific rules. */
export function printedTransactionType(description: string, evidence: string[], direction: string, accountKind: string):
  { type: string; basis: string; requiresReview?: boolean } | null {
  const summary = semanticText(description);
  const context = evidence.map(semanticText);
  const has = (pattern: RegExp) => context.some(s => pattern.test(s));
  const result = (type: string, basis: string) => ({ type, basis });
  if (direction === 'OUT') {
    const credit = has(/信用卡.{0,8}还款|贷记卡.{0,8}还款/);
    const loan = has(/贷款还款|归还贷款|偿还贷款|还贷/);
    if (credit && loan) return result('', 'CONFLICTING_PRINTED_REPAYMENT_PURPOSES');
    if (credit) return result('信用卡还款', 'PRINTED_CREDIT_CARD_REPAYMENT_PURPOSE');
    if (loan) return result('贷款还款', 'PRINTED_LOAN_REPAYMENT_PURPOSE');
    // "还款" alone does not establish whether this is a loan or a credit card.
    if (has(/还款/) && !/^(?:自动还款|人民币自动转帐还款|微众银行还款)$/.test(summary)) {
      return { type: summary === '消费' ? '消费' : '', basis: 'PRINTED_REPAYMENT_KIND_UNRESOLVED', requiresReview: true };
    }
  }
  if (/分期付款退货/.test(summary)) return result('分期退款', 'PRINTED_INSTALLMENT_REFUND');
  if (/消费退货|消费退款|^退货$|^退款$/.test(summary)) return result('退款', 'PRINTED_PURCHASE_REFUND');
  if (accountKind === 'deposit') {
    if (direction === 'IN' && /^(?:现金存入|现金存款|存现|.{1,12}存现)$/.test(summary)) return result('现金存入', 'PRINTED_CASH_DEPOSIT');
    if (direction === 'OUT' && /^(?:现金支取|现金取款|取现|.{1,12}取现)$/.test(summary)) return result('现金支取', 'PRINTED_CASH_WITHDRAWAL');
    if (direction === 'IN' && (/^银联入账|^支付机构提现/.test(summary)
      || has(/(?:微信|零钱|余额宝|支付宝).{0,8}提现/))) return result('第三方支付', 'PRINTED_PAYMENT_SETTLEMENT_OR_WALLET_WITHDRAWAL');
    if (/^(?:快捷支付|网上支付)/.test(summary) && direction === 'OUT') return result('第三方支付', 'PRINTED_QUICK_PAYMENT');
    if (summary === '入金' && has(/支付宝|财付通|微信|银联|支付有限公司|支付股份有限公司/)) {
      return result('第三方支付', 'PRINTED_PAYMENT_PROVIDER_CREDIT');
    }
    if (direction === 'OUT' && summary === '充值' && has(/(?:微信|支付宝|财付通|余额宝).{0,12}充值/)) {
      return result('第三方支付', 'PRINTED_PAYMENT_WALLET_TOPUP');
    }
  }
  return null;
}
