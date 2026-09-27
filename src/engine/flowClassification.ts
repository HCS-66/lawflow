import { FlowDirection, StandardTransaction } from '../types/transaction';
import { isJudicialDeduction } from './bilateral';

export type FlowCategoryCode =
  | 'LOAN_DISBURSEMENT'
  | 'SALARY_INCOME'
  | 'REFUND_REVERSAL'
  | 'INTEREST_INCOME'
  | 'TRANSFER_IN'
  | 'OTHER_IN'
  | 'JUDICIAL_DEDUCTION'
  | 'CASH_WITHDRAWAL'
  | 'LOAN_REPAYMENT'
  | 'INVESTMENT_WEALTH'
  | 'INSURANCE'
  | 'TAX_AND_FEES'
  | 'CONSUMPTION'
  | 'TRANSFER_OUT'
  | 'OTHER_OUT';

export interface FlowClassification {
  code: FlowCategoryCode;
  label: string;
  direction: Exclude<FlowDirection, 'UNKNOWN'>;
  color: string;
  priority: number;
}

const definitions: Record<FlowCategoryCode, Omit<FlowClassification, 'code'>> = {
  LOAN_DISBURSEMENT: { label: '贷款放款', direction: 'IN', color: '#2563eb', priority: 90 },
  SALARY_INCOME: { label: '工资及劳务收入', direction: 'IN', color: '#059669', priority: 80 },
  REFUND_REVERSAL: { label: '退款及冲正', direction: 'IN', color: '#0d9488', priority: 60 },
  INTEREST_INCOME: { label: '利息及结息', direction: 'IN', color: '#65a30d', priority: 40 },
  TRANSFER_IN: { label: '他人转入', direction: 'IN', color: '#10b981', priority: 50 },
  OTHER_IN: { label: '其他／待核对流入', direction: 'IN', color: '#94a3b8', priority: 100 },
  JUDICIAL_DEDUCTION: { label: '司法划扣', direction: 'OUT', color: '#be123c', priority: 100 },
  CASH_WITHDRAWAL: { label: '现金取现', direction: 'OUT', color: '#b91c1c', priority: 90 },
  LOAN_REPAYMENT: { label: '贷款及信用卡还款', direction: 'OUT', color: '#7c3aed', priority: 80 },
  INVESTMENT_WEALTH: { label: '投资理财及证券', direction: 'OUT', color: '#0891b2', priority: 75 },
  INSURANCE: { label: '保险支出', direction: 'OUT', color: '#0f766e', priority: 70 },
  TAX_AND_FEES: { label: '税费及银行费用', direction: 'OUT', color: '#d97706', priority: 65 },
  CONSUMPTION: { label: '消费及生活支出', direction: 'OUT', color: '#ea580c', priority: 50 },
  TRANSFER_OUT: { label: '对外转账', direction: 'OUT', color: '#64748b', priority: 40 },
  OTHER_OUT: { label: '其他／待核对流出', direction: 'OUT', color: '#94a3b8', priority: 100 }
};

export function classifyTransactionFlow(transaction: StandardTransaction): FlowClassification | undefined {
  if (transaction.isInternalTransfer || transaction.direction === 'UNKNOWN') return undefined;
  const standard: Record<string, Partial<Record<'IN' | 'OUT', FlowCategoryCode>>> = {
    '司法扣划': { OUT: 'JUDICIAL_DEDUCTION' }, '贷款放款': { IN: 'LOAN_DISBURSEMENT' },
    '贷款还款': { OUT: 'LOAN_REPAYMENT' }, '信用卡还款': { OUT: 'LOAN_REPAYMENT', IN: 'TRANSFER_IN' },
    '工资收入': { IN: 'SALARY_INCOME' }, '存款结息': { IN: 'INTEREST_INCOME' },
    '退款': { IN: 'REFUND_REVERSAL' }, '分期退款': { IN: 'REFUND_REVERSAL' },
    '手续费': { OUT: 'TAX_AND_FEES' }, '透支利息': { OUT: 'TAX_AND_FEES' },
    '保险支出': { OUT: 'INSURANCE' }, '消费': { OUT: 'CONSUMPTION' }, '缴费': { OUT: 'CONSUMPTION' },
    '账户转账': { IN: 'TRANSFER_IN', OUT: 'TRANSFER_OUT' }, '第三方支付': { IN: 'TRANSFER_IN', OUT: 'TRANSFER_OUT' },
    '分期': { OUT: 'LOAN_REPAYMENT' }
  };
  const selected = standard[transaction.transactionType || '']?.[transaction.direction];
  if (selected) return { code: selected, ...definitions[selected] };
  const text = `${transaction.summary || ''} ${transaction.counterpartyName || ''} ${transaction.counterpartyBank || ''} ${transaction.rawText || ''}`.toLowerCase();
  let code: FlowCategoryCode;
  if (transaction.direction === 'IN') {
    if (/放款|贷款入账|贷款发放|借款发放/.test(text)) code = 'LOAN_DISBURSEMENT';
    else if (/工资|薪资|薪酬|奖金|劳务|代发/.test(text)) code = 'SALARY_INCOME';
    else if (/退款|退货|冲正|撤销|退汇/.test(text)) code = 'REFUND_REVERSAL';
    else if (/结息|利息收入|存款利息/.test(text)) code = 'INTEREST_INCOME';
    else if (/转账|汇款|入账|收款/.test(text) || transaction.counterpartyName || transaction.counterpartyAccount) code = 'TRANSFER_IN';
    else code = 'OTHER_IN';
  } else {
    if (isJudicialDeduction(transaction)) code = 'JUDICIAL_DEDUCTION';
    else if (/\batm\b|现金取款|现金支取|取现|柜面取款/.test(text)) code = 'CASH_WITHDRAWAL';
    else if (/贷款还款|偿还贷款|还贷|还本|按揭|房贷|车贷|信用卡还款|透支还款|分期付款到期扣收/.test(text)) code = 'LOAN_REPAYMENT';
    else if (/理财|基金|证券|银证|股票|债券|贵金属|黄金|投资/.test(text)) code = 'INVESTMENT_WEALTH';
    else if (/保险|保费|寿险|财险/.test(text)) code = 'INSURANCE';
    else if (/手续费|服务费|年费|工本费|账户管理费|税款|税费|纳税|透支利息|罚息/.test(text)) code = 'TAX_AND_FEES';
    else if (/消费|购物|餐饮|商户|pos|快捷支付|微信|支付宝|财付通|京东|美团|拼多多|水费|电费|燃气|话费/.test(text)) code = 'CONSUMPTION';
    else if (/转账|汇款|付款|支付/.test(text) || transaction.counterpartyName || transaction.counterpartyAccount) code = 'TRANSFER_OUT';
    else code = 'OTHER_OUT';
  }
  return { code, ...definitions[code] };
}
