import { accountFromSource, bankFromSource, type SourceRegistry } from './sourceAssembly';
import type { IndependentPage } from './independentComparison';

/** Share an issuer only across exact account identifiers supported by two readings. */
export function collectAccountIssuers(registry: SourceRegistry, independent: Record<number, IndependentPage>) {
  const evidence = new Map<string, Map<string, string[]>>();
  for (const [pageText, reading] of Object.entries(independent)) {
    if (reading.coverage !== 'complete' || !reading.bankName) continue;
    const page = Number(pageText), bank = bankFromSource(reading.bankName);
    if (!bank || /^(?:商业银行|商业银行股份有限公司)$/.test(bank)) continue;
    const printed = Object.values(registry.cells).filter(c => c.page === page && c.row === null
      && /银行/.test(c.text) && bankFromSource(c.text) === bank);
    if (!printed.length) continue;
    const accounts = new Set([...(reading.ownerIdentifiers || []).filter(id => ['account', 'card'].includes(id.role)).map(id => id.value),
      ...reading.rows.map(row => row.values[0])].map(accountFromSource).filter((v): v is string => Boolean(v && /^\d{8,32}$/.test(v))));
    for (const account of accounts) {
      const banks = evidence.get(account) || new Map<string, string[]>();
      banks.set(bank, [...(banks.get(bank) || []), ...printed.map(c => `cell:${c.id}`), `independent:p${page}:issuerAndOwner`]);
      evidence.set(account, banks);
    }
  }
  return evidence;
}
