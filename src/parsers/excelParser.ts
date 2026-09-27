import ExcelJS from 'exceljs';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { parseStandardStatementRows } from './standardStatementCsv';

/**
 * Universal bank statement Excel / CSV parser.
 * Automatically identifies bank column mappings.
 */
export async function parseExcelBankStatement(
  file: File
): Promise<{
  account: BankAccount;
  accounts?: BankAccount[];
  transactions: StandardTransaction[];
}> {
  let rows: any[][];
  if (file.name.toLowerCase().endsWith('.csv')) {
    rows = parseCsvRows(await file.text());
    const standard = parseStandardStatementRows(rows, file.name);
    if (standard) return standard;
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error('工作簿中没有可读取的工作表');
    rows = [];
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows[rowNumber - 1] = values.map(normalizeCellValue);
    });
  }

  if (!rows || rows.length < 2) {
    throw new Error('未在 Excel 中识别到有效的流水表格数据');
  }

  // 1. Locate header row
  let headerRowIndex = -1;
  let colMap: Record<string, number> = {};

  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const row = rows[r].map(c => String(c).trim());
    const dateIdx = row.findIndex(c => /日期|交易日|记账日|时间/.test(c));
    const amountIdx = row.findIndex(c => /金额|发生额|借贷|支出|存入/.test(c));

    if (dateIdx !== -1 && amountIdx !== -1) {
      headerRowIndex = r;
      // Map all relevant columns
      row.forEach((colName, idx) => {
        if (/交易日|记账日|日期|时间/.test(colName) && !colMap['date']) colMap['date'] = idx;
        if (/支出|借方|借额|付出/.test(colName)) colMap['out'] = idx;
        if (/存入|收入|贷方|贷额|进账/.test(colName)) colMap['in'] = idx;
        if (/金额|发生额|交易金额/.test(colName) && !colMap['amount']) colMap['amount'] = idx;
        if (/借贷|标志|方向|收支/.test(colName) && !colMap['direction']) colMap['direction'] = idx;
        if (/余额|账户余额|本次余额/.test(colName) && !colMap['balance']) colMap['balance'] = idx;
        if (/对方户名|对方名称|对手方|户名|交易对手/.test(colName) && !colMap['counterpartyName']) colMap['counterpartyName'] = idx;
        if (/对方账号|对方卡号|对手账号/.test(colName) && !colMap['counterpartyAccount']) colMap['counterpartyAccount'] = idx;
        if (/对方开户行|对方行名/.test(colName) && !colMap['counterpartyBank']) colMap['counterpartyBank'] = idx;
        if (/摘要|附言|备注|交易说明|用途|附注/.test(colName) && !colMap['summary']) colMap['summary'] = idx;
      });
      break;
    }
  }

  if (headerRowIndex === -1) {
    // Fallback: assume row 0 is header
    headerRowIndex = 0;
    colMap = { date: 0, amount: 1, direction: 2, balance: 3, counterpartyName: 4, summary: 5 };
  }

  // 2. Extract account info from header preamble if available
  let bankName = '商业银行';
  let accountName = '';
  let accountNumber = '';

  for (let r = 0; r < headerRowIndex; r++) {
    const rowText = rows[r].join(' ');
    if (/建设银行|建行/.test(rowText)) bankName = '建设银行';
    else if (/工商银行|工行/.test(rowText)) bankName = '工商银行';
    else if (/农业银行|农行/.test(rowText)) bankName = '农业银行';
    else if (/中国银行|中行/.test(rowText)) bankName = '中国银行';
    else if (/招商银行|招行/.test(rowText)) bankName = '招商银行';
    else if (/交通银行|交行/.test(rowText)) bankName = '交通银行';
    else if (/邮储银行|邮政/.test(rowText)) bankName = '邮储银行';

    const accMatch = rowText.match(/账号|卡号[：:\s]+([0-9]{12,25})/);
    if (accMatch) accountNumber = accMatch[1];

    const nameMatch = rowText.match(/户名|客户名称[：:\s]+([\u4e00-\u9fa5a-zA-Z0-9（）()]+)/);
    if (nameMatch) accountName = nameMatch[1];
  }

  if (!accountNumber) {
    accountNumber = `ACC_${file.name.replace(/[^0-9]/g, '') || Math.floor(Math.random() * 1000000)}`;
  }
  if (!accountName) {
    accountName = file.name.split('.')[0];
  }

  // 3. Extract transaction rows
  const transactions: StandardTransaction[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let startBalance = 0;
  let endBalance = 0;
  let earliestDate = '9999-12-31';
  let latestDate = '1900-01-01';

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const rawDate = String(row[colMap['date']] || '').trim();
    if (!rawDate || rawDate.length < 6) continue;

    const formattedDate = parseDateString(rawDate);
    if (!formattedDate) continue;

    let amount = 0;
    let direction: 'IN' | 'OUT' = 'OUT';

    if (colMap['out'] !== undefined && colMap['in'] !== undefined) {
      const outVal = cleanNumber(row[colMap['out']]);
      const inVal = cleanNumber(row[colMap['in']]);
      if (outVal > 0) {
        amount = outVal;
        direction = 'OUT';
      } else if (inVal > 0) {
        amount = inVal;
        direction = 'IN';
      }
    } else if (colMap['amount'] !== undefined) {
      const signedAmount = signedNumber(row[colMap['amount']]);
      amount = Math.abs(signedAmount);
      const dirText = String(row[colMap['direction']] || '').trim();
      if (/存入|进|贷|收|\+/.test(dirText)) {
        direction = 'IN';
      } else if (/支|出|借|-/.test(dirText)) {
        direction = 'OUT';
      } else {
        direction = signedAmount < 0 ? 'OUT' : 'IN';
      }
    }

    if (amount <= 0) continue;

    const balance = colMap['balance'] !== undefined ? cleanNumber(row[colMap['balance']]) : 0;
    const cpName = colMap['counterpartyName'] !== undefined ? String(row[colMap['counterpartyName']]).trim() : '';
    const cpAcc = colMap['counterpartyAccount'] !== undefined ? String(row[colMap['counterpartyAccount']]).trim() : '';
    const cpBank = colMap['counterpartyBank'] !== undefined ? String(row[colMap['counterpartyBank']]).trim() : '';
    const summary = colMap['summary'] !== undefined ? String(row[colMap['summary']]).trim() : '';

    if (direction === 'IN') totalIn += amount;
    else totalOut += amount;

    if (formattedDate < earliestDate) earliestDate = formattedDate;
    if (formattedDate > latestDate) latestDate = formattedDate;

    if (transactions.length === 0) {
      startBalance = direction === 'IN' ? balance - amount : balance + amount;
    }
    endBalance = balance;

    transactions.push({
      id: `TX_${accountNumber}_${r}_${Math.floor(Math.random() * 1000)}`,
      accountNumber,
      accountName,
      bankName,
      transactionTime: formattedDate,
      transactionDate: formattedDate.split(' ')[0],
      direction,
      amount,
      balance,
      counterpartyName: cpName,
      counterpartyAccount: cpAcc,
      counterpartyBank: cpBank,
      summary,
      rawSourceFile: file.name,
      rawRowIndex: r + 1
    });
  }

  const account: BankAccount = {
    accountNumber,
    accountName,
    bankName,
    ownerType: 'DEBTOR_MAIN',
    fileName: file.name,
    fileType: 'excel',
    totalIn,
    totalOut,
    transactionCount: transactions.length,
    startDate: earliestDate === '9999-12-31' ? '' : earliestDate,
    endDate: latestDate === '1900-01-01' ? '' : latestDate,
    startBalance,
    endBalance,
    isBalanced: true,
    balanceDiff: 0,
    balanceAvailable: colMap['balance'] !== undefined
  };

  return { account, transactions };
}

function normalizeCellValue(value: ExcelJS.CellValue): string | number {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined) return normalizeCellValue(value.result as ExcelJS.CellValue);
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map(item => item.text).join('');
    return String(value);
  }
  return typeof value === 'boolean' ? String(value) : value;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cleanNumber(val: any): number {
  return Math.abs(signedNumber(val));
}

function signedNumber(val: any): number {
  if (typeof val === 'number') return val;
  const s = String(val || '').replace(/[,¥$\s]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseDateString(s: string): string {
  s = s.replace(/[\/\.年月日\s]/g, '-').replace(/-+/g, '-').trim();
  const parts = s.split('-');
  if (parts.length >= 3) {
    const y = parts[0].length === 4 ? parts[0] : (parts[0].length === 2 ? `20${parts[0]}` : '2024');
    const m = parts[1].padStart(2, '0');
    const d = parts[2].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}
