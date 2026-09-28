import { runQualityTrial } from './qualityTrialPipeline';
import { withAnalysisTypeChecks } from '../review/qualityDelivery';
import { buildQualitySources, stabilizeQualityMapping } from './qualitySources';
import { decidePreflight, type ModelReply, type PageMetrics, type QualityRequest, type VerbatimPage } from './qualityProtocol';
import { planPrimaryRecovery } from './primaryRecoveryPlan';
import { planAccountRecovery } from './accountRecoveryPlan';
import { planCriticalFieldRecovery } from './criticalFieldRecovery';
import type { IndependentPage } from './independentComparison';
import type { FocusedAccounts } from './accountRecovery';
import type { TableMappingPlan } from './tableMapping';

export interface QualityWorkflowIO {
  totalPages: number;
  preflightImages(page: number): Promise<{ images: string[]; metrics: PageMetrics }>;
  image(page: number, rotation: number, dpi: number): Promise<string>;
  call(input: QualityRequest, page: number): Promise<ModelReply>;
  progress(message: string, percent: number, rows?: number): void;
  signal: AbortSignal;
}
/** The browser and replay tests use the same orchestration and bounded recovery policies. */
export async function runQualityWorkflow(io: QualityWorkflowIO) {
  const preflight: Array<{ reading: any; decision: ReturnType<typeof decidePreflight>; metrics: PageMetrics }> = [];
  const primary: VerbatimPage[] = [], context: VerbatimPage[] = [];
  const independent: Record<number, IndependentPage> = {}, accounts: Record<number, FocusedAccounts> = {}, critical: Record<number, IndependentPage> = {};
  const check = () => io.signal.throwIfAborted();
  const parallelPages = async (pages: number[], fn: (page: number) => Promise<void>) => {
    let index = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(3, pages.length) }, async () => {
      while (index < pages.length) { check(); await fn(pages[index++]); }
    }));
    const error = outcomes.find((r): r is PromiseRejectedResult => r.status === 'rejected'); if (error) throw error.reason;
  };
  const pages = Array.from({ length: io.totalPages }, (_, i) => i + 1);
  let completed = 0;
  // No transcription starts until the complete page inventory has passed Gemini preflight.
  await parallelPages(pages, async page => {
    io.progress(`检查空白页和方向：第 ${page}/${io.totalPages} 页`, 2 + completed / io.totalPages * 16);
    const { images, metrics } = await io.preflightImages(page);
    const { result: reading } = await io.call({ stage: 'preflight', images }, page); check();
    preflight[page - 1] = { reading, metrics, decision: decidePreflight(reading, metrics) }; completed++;
  });
  completed = 0;
  await parallelPages(pages, async page => {
    check(); const decision = preflight[page - 1].decision;
    if (decision.blankConfirmed) {
      primary[page - 1] = { nearTableText: [], tables: [] }; context[page - 1] = { nearTableText: [], tables: [] };
      independent[page] = { pageType: 'blank', coverage: 'complete', pageIssues: [], rows: [], bankName: '', ownerNames: [], ownerIdentifiers: [] };
    } else {
      io.progress(`照录整页原文：第 ${page}/${io.totalPages} 页`, 18 + completed / io.totalPages * 48);
      const image = await io.image(page, decision.clockwiseRotation, 350);
      // Independent reader receives only the image, never the primary transcript.
      primary[page - 1] = (await io.call({ stage: 'primary', images: [image] }, page)).result;
      independent[page] = (await io.call({ stage: 'independent', images: [image] }, page)).result;
      context[page - 1] = (await io.call({ stage: 'context', images: [image] }, page)).result;
      if (decision.orientationUncertain) {
        independent[page] = { ...independent[page], coverage: 'uncertain',
          pageIssues: [...independent[page].pageIssues, '页面方向未能确认，请查看整页原件'] };
      }
    }
    completed++;
  });
  const merged = () => primary.map((p, i) => ({ ...p, nearTableText: [...new Set([...p.nearTableText, ...context[i].nearTableText])] }));
  let { registry, source } = buildQualitySources(merged());
  io.progress('按完整原文列表整理账户和流水…', 68);
  let mapping: TableMappingPlan = (await io.call({ stage: 'mapping', source }, 0)).result;
  // A PDF upload can contain multiple banks; do not assume a single issuer from a filename.
  const scope = { singleIssuerDocument: false };
  let result = runQualityTrial(mapping, registry, independent, scope);
  const primaryPlan = planPrimaryRecovery(result.pending, registry);
  if (primaryPlan.selected.length) {
    io.progress(`核实 ${primaryPlan.selected.length} 页的行数差异…`, 74);
    await parallelPages(primaryPlan.selected.map(p => p.page), async page => {
      const image = await io.image(page, preflight[page - 1].decision.clockwiseRotation, 250);
      primary[page - 1] = (await io.call({ stage: 'primaryRecovery', images: [image] }, page)).result;
    });
    const next = buildQualitySources(merged());
    const fresh: TableMappingPlan = (await io.call({ stage: 'mapping', source: next.source }, 0)).result;
    mapping = stabilizeQualityMapping(mapping, fresh, registry, next.registry); registry = next.registry; source = next.source;
    result = runQualityTrial(mapping, registry, independent, scope);
  }
  const accountPlan = planAccountRecovery(result.pending, registry, independent);
  io.progress(`核实账号归属${accountPlan.selected.length ? `（${accountPlan.selected.length} 页）` : ''}…`, 82, result.rows.length);
  await parallelPages(accountPlan.selected.map(p => p.page), async page => {
    accounts[page] = (await io.call({ stage: 'accounts', images: [await io.image(page, preflight[page - 1].decision.clockwiseRotation, 350)] }, page)).result;
  });
  result = runQualityTrial(mapping, registry, independent, scope, accounts);
  const criticalPlan = planCriticalFieldRecovery(result.pending, registry);
  io.progress(`核实关键字段差异${criticalPlan.selected.length ? `（${criticalPlan.selected.length} 页）` : ''}…`, 90, result.rows.length);
  await parallelPages(criticalPlan.selected.map(p => p.page), async page => {
    critical[page] = (await io.call({ stage: 'critical', images: [await io.image(page, preflight[page - 1].decision.clockwiseRotation, 350)] }, page)).result;
  });
  check(); result = withAnalysisTypeChecks(runQualityTrial(mapping, registry, independent, scope, accounts, critical), registry);
  io.progress('已完成识别并列出待确认项', 100, result.rows.length);
  return { result, registry, mapping, preflight, primary, context, independent, accounts, critical,
    recoveryPlans: { primary: primaryPlan, accounts: accountPlan, critical: criticalPlan } };
}
