/** One Gemini request from a PDF, optionally with cached MinerU text, to twelve-column CSV. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fields = [
  'accountNumber', 'accountName', 'bankName', 'transactionTime', 'transactionDate',
  'direction', 'amount', 'balance', 'transactionType', 'counterpartyName',
  'counterpartyAccount', 'counterpartyBank',
] as const;
type Field = typeof fields[number];
type Row = Record<Field, string>;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pdfPath = path.resolve(args.pdf);
  const outDir = path.resolve(args.out);
  const mineruPath = args.mineruJson ? path.resolve(args.mineruJson) : null;
  const promptPath = path.resolve(args.prompt || path.join(root, 'scripts/prompts',
    mineruPath ? 'geminiPdfMineruToCsv.txt' : 'geminiPdfToCsv.txt'));
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const apiKey = process.env.GEMINI_API_KEY || await readLocalKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  await mkdir(outDir, { recursive: true });

  const [pdf, prompt] = await Promise.all([readFile(pdfPath), readFile(promptPath, 'utf8')]);
  let inputText = prompt;
  if (mineruPath) {
    const mineru = JSON.parse(await readFile(mineruPath, 'utf8')) as { pages?: Array<{ page: number; text: string }> };
    if (!Array.isArray(mineru.pages)) throw new Error('MinerU JSON has no pages array');
    inputText += `\n\nMinerU 逐页文字：${JSON.stringify(mineru.pages.map(page => ({ page: page.page, text: page.text })))}`;
  }
  console.log(`Input: PDF${mineruPath ? ` + MinerU text (${inputText.length} characters)` : ' only'}`);
  await writeFile(path.join(outDir, 'prompt-used.txt'), inputText);
  const started = Date.now();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: inputText },
        { inline_data: { mime_type: 'application/pdf', data: pdf.toString('base64') } },
      ] }],
      generationConfig: {
        responseMimeType: 'application/json', temperature: 0,
        thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 65536,
      },
    }),
  });
  const payload: any = await response.json().catch(() => ({}));
  await writeFile(path.join(outDir, 'gemini-response.json'), JSON.stringify(payload, null, 2));
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${String(payload.error?.message || '').slice(0, 300)}`);
  const candidate = payload.candidates?.[0];
  const finishReason = String(candidate?.finishReason || '');
  const raw = (candidate?.content?.parts || []).map((part: { text?: string }) => part.text || '').join('').trim();
  await writeFile(path.join(outDir, 'gemini-output.txt'), raw);
  if (finishReason !== 'STOP') throw new Error(`Gemini stopped with ${finishReason || 'no finish reason'}`);
  const parsed = JSON.parse(raw) as { rows?: unknown[] };
  if (!Array.isArray(parsed.rows)) throw new Error('Gemini returned no rows array');
  const rows: Row[] = parsed.rows.map((item, index) => {
    if (!Array.isArray(item) || item.length !== fields.length || item.some(value => typeof value !== 'string')) {
      throw new Error(`Row ${index + 1} does not contain exactly twelve strings`);
    }
    return Object.fromEntries(fields.map((field, position) => [field, item[position]])) as Row;
  });
  await writeFile(path.join(outDir, 'candidate.csv'), encodeCsv(rows));

  const report: Record<string, unknown> = {
    pdfPath, promptPath, mineruPath, model, candidateRows: rows.length,
    seconds: (Date.now() - started) / 1000,
    usage: payload.usageMetadata || null,
  };
  if (args.gold) {
    const goldPath = path.resolve(args.gold);
    const gold = parseCsv(await readFile(goldPath, 'utf8'));
    const alignedByTransaction = rows.length === gold.length && rows.every((row, index) =>
      ['transactionDate', 'direction', 'amount', 'balance'].every(field =>
        row[field as Field] === gold[index][field as Field]));
    const fieldDifferences = alignedByTransaction
      ? Object.fromEntries(fields.map(field => [field, rows.filter((row, index) => row[field] !== gold[index][field]).length]))
      : null;
    Object.assign(report, { goldPath, goldRows: gold.length, alignedByTransaction,
      fieldDifferences, ...compareRows(rows, gold) });
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputDir: outDir, candidateRows: rows.length,
    goldRows: report.goldRows, exactRows: report.exactRows,
    alignedByTransaction: report.alignedByTransaction,
    fieldDifferences: report.fieldDifferences, seconds: report.seconds,
    usage: report.usage }, null, 2));
}

function parseArgs(argv: string[]) {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--pdf', '--out', '--gold', '--prompt', '--mineru-json'].includes(key) || !argv[i + 1]) {
      throw new Error('Usage: --pdf <file> --out <directory> [--gold <csv>] [--prompt <txt>] [--mineru-json <json>]');
    }
    options[key === '--mineru-json' ? 'mineruJson' : key.slice(2)] = argv[i + 1];
  }
  if (!options.pdf || !options.out) throw new Error('--pdf and --out are required');
  return options as { pdf: string; out: string; gold?: string; prompt?: string; mineruJson?: string };
}

async function readLocalKey(): Promise<string> {
  try {
    const text = await readFile(path.join(root, '.dev.vars'), 'utf8');
    const value = text.split(/\r?\n/).find(line => /^\s*GEMINI_API_KEY\s*=/.test(line))?.split('=').slice(1).join('=').trim() || '';
    return value.replace(/^['"]|['"]$/g, '');
  } catch { return ''; }
}

function encodeCsv(rows: Row[]): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return [fields, ...rows.map(row => fields.map(field => row[field]))]
    .map(line => line.map(quote).join(',')).join('\r\n') + '\r\n';
}

function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(value => value !== '')) records.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); records.push(row); }
  const [header, ...data] = records;
  return data.map(values => Object.fromEntries(fields.map(field =>
    [field, values[header.indexOf(field)] || ''])) as Row);
}

function compareRows(actual: Row[], gold: Row[]) {
  const signature = (row: Row) => fields.map(field => row[field]).join('\u0000');
  const pool = new Map<string, number>();
  for (const row of gold) pool.set(signature(row), (pool.get(signature(row)) || 0) + 1);
  let exactRows = 0;
  const unmatchedActual: Row[] = [];
  for (const row of actual) {
    const key = signature(row), count = pool.get(key) || 0;
    if (count) { exactRows++; pool.set(key, count - 1); }
    else unmatchedActual.push(row);
  }
  const remaining = new Map(pool);
  const unmatchedGold = gold.filter(row => {
    const key = signature(row), count = remaining.get(key) || 0;
    if (!count) return false;
    remaining.set(key, count - 1);
    return true;
  });
  return { exactRows, unmatchedActualRows: unmatchedActual.length, unmatchedGoldRows: unmatchedGold.length,
    unmatchedActual, unmatchedGold };
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
