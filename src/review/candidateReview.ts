import type { StandardTransaction, TransactionEvidenceField } from '../types/transaction';

const labels: Record<TransactionEvidenceField, string> = {
  accountName: '本方名称', bankName: '本方银行', transactionDate: '交易日期', transactionType: '交易类型', counterpartyBank: '对方银行',
  accountNumber: '本方账号', transactionTime: '日期／时间', direction: '收支方向', amount: '金额',
  balance: '交易后余额', counterpartyName: '对手方名称', counterpartyAccount: '对手方账号', summary: '摘要'
};
function display(value: string | number | null): string {
  return value === null || value === '' ? '未读到' : value === 'IN' ? '收入' : value === 'OUT' ? '支出' : String(value);
}
export function candidateReviewTitle(row: StandardTransaction): string {
  const review = row.candidateReview;
  if (review?.kind === 'SOURCE_CHECK') {
    const fields = [...new Set([...(review.requiredFields || []), ...review.differences.map(item => item.field)])];
    return fields.length ? `核对${fields.map(field => labels[field]).join('、')}` : '核对标出的交易字段';
  }
  return review?.kind === 'FIELD_CONFLICT' ? '两次读取的字段不同' : '确认这行是否完整读取';
}
export function candidateReviewDescription(row: StandardTransaction): string {
  const review = row.candidateReview;
  if (!review) return '';
  if (review.kind === 'SOURCE_CHECK') return review.reason || '请对照原件核对列出的字段。';
  if (review.kind === 'UNMATCHED_ROW') return (review.reason ? review.reason + '；' : '') + '另一份读取结果没有找到能唯一对应的这笔流水。请在原件中找到这一行，确认它确实存在，再逐项核对下面的字段。';
  if (review.kind === 'AMBIGUOUS_ROW') return (review.reason ? review.reason + '；' : '') + '两份读取结果无法唯一对应这行（可能同日多笔或账号／日期不清）。请定位原件这一行，逐项核对；系统没有按行号拼接。';
  return (review.reason ? review.reason + '；' : '') + review.differences.map(item => `${labels[item.field]}：当前读取为“${display(item.selected)}”，另一次读取为“${display(item.alternative)}”`).join('；')
    + '。请对照原件填写正确值，两次读取都不等于已确认。';
}
export function hasPendingCandidateReview(row: StandardTransaction): boolean {
  return Boolean(row.candidateReview && row.candidateReview.status !== 'CONFIRMED');
}
