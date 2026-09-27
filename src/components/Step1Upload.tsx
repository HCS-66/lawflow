import React, { useEffect, useState, useRef } from 'react';
import { UploadCloud, FileSpreadsheet, FileText, FileImage, CheckCircle2, ArrowRight, ArrowLeft, Trash2, PlusCircle, AlertCircle, ShieldCheck, Sparkles, StopCircle, RotateCcw, CircleSlash2, Scissors, Clipboard, ClipboardCheck } from 'lucide-react';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { parseExcelBankStatement } from '../parsers/excelParser';
import type { GeminiProgressInfo } from '../parsers/geminiPdfParser';
import { parsePdfWithMinerU } from '../parsers/mineruBankStatementParser';
import { deleteSourceDocument, saveSourceDocument } from '../store/sourceDocumentStore';
import { createRecognitionCheckpointStore, clearRecognitionCheckpoints } from '../store/recognitionCheckpointStore';
import { accountIdentityKey, transactionBelongsToAccount } from '../utils/accountIdentity';
import { importErrorForUser } from '../utils/userFacingError';
import { attachSourceProvenance, createExtractionRun, identifySourceDocument, sourceFilesWithoutTransactions, sourceIdentity, transactionCountsBySource } from '../utils/evidenceProvenance';
import { publishAutomationImportState, publishRecognitionCheckpoint } from '../debug/automationBridge';
import { normalizeRecognizedData } from '../utils/recognizedDataNormalizer';
import { businessAccounts, incompleteRecognitionPages, isDocumentReviewAccount } from '../review/recognitionCompleteness';
import {
  createBankSplitFiles,
  buildPdfBankSplitSuggestion,
  getRecognitionSplitMetadata,
  isPageRecommendedForRecognition,
  PdfBankSplitPlan,
  PdfPageClassification,
  formatPageSelection,
  parsePageSelection,
  preparePdfBankSplitPlan,
  releasePdfSplitPlanPreviews,
  validateBankGroups
} from '../parsers/pdfBankSplitter';
import { discoverPdfPageMapWithMinerU } from '../parsers/mineruPdfParser';
import { PdfTimelineEditor } from './PdfTimelineEditor';
import { formatRecognitionDiagnostics } from '../review/recognitionDiagnostics';
import { copyText } from '../utils/copyText';

interface Step1Props {
  caseId: string;
  caseRespondentName?: string;
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  onDataUpdated: (accounts: BankAccount[], transactions: StandardTransaction[]) => void;
  onNext: () => void;
  onPrev: () => void;
}

type ImportTaskStatus = 'QUEUED' | 'PROCESSING' | 'SUCCESS' | 'WARNING' | 'EMPTY' | 'ERROR' | 'CANCELLED';

interface ImportTask {
  id: string;
  file: File;
  status: ImportTaskStatus;
  title: string;
  message?: string;
  impact?: string;
  details?: string;
  retryable?: boolean;
  transactionCount?: number;
  accountCount?: number;
  diagnosticCode?: string;
  diagnosis?: string;
}

function importTaskId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function formatImportTasksForCopy(tasks: ImportTask[]): string {
  const statusLabel: Record<ImportTaskStatus, string> = {
    QUEUED: '等待处理', PROCESSING: '处理中', SUCCESS: '导入成功', WARNING: '有提示',
    EMPTY: '未识别到流水', ERROR: '导入失败', CANCELLED: '已取消'
  };
  const lines = ['# 本次文件处理结果', '', `- 文件数：${tasks.length}`];
  tasks.forEach((task, index) => {
    const safeDetails = String(task.details || '')
      .replace(/Bearer\s+\S+/gi, '服务凭据')
      .replace(/([?&]key=)[^&\s]+/gi, '$1[已隐藏]');
    lines.push('', `## ${index + 1}. ${task.file.name}`);
    lines.push(`- 状态：${statusLabel[task.status]}`);
    lines.push(`- 结果：${task.title}`);
    if (task.transactionCount !== undefined) lines.push(`- 流水：${task.transactionCount} 笔`);
    if (task.accountCount !== undefined) lines.push(`- 账户：${task.accountCount} 个`);
    if (task.message) lines.push(`- 说明：${task.message}`);
    if (task.impact) lines.push(`- 影响：${task.impact}`);
    if (task.diagnosticCode) lines.push(`- 诊断代码：${task.diagnosticCode}`);
    if (task.diagnosis) lines.push(`- 具体诊断：${task.diagnosis}`);
    if (safeDetails) lines.push(`- 错误详情：${safeDetails}`);
  });
  return lines.join('\n');
}

function pdfGroupPages(group: PdfBankSplitPlan['groups'][number], totalPages: number): number[] {
  try {
    const pages = parsePageSelection(group.pageSelection, totalPages);
    return pages.length ? pages : group.pages;
  } catch {
    return group.pages;
  }
}

function continuousPages(start: number, end: number): number[] {
  return start <= end ? Array.from({ length: end - start + 1 }, (_, index) => start + index) : [];
}

function withSyncedPdfAssignments(plan: PdfBankSplitPlan, groups: PdfBankSplitPlan['groups']): PdfBankSplitPlan {
  const bankByPage = new Map<number, string>();
  for (const group of groups) {
    for (const page of pdfGroupPages(group, plan.totalPages)) bankByPage.set(page, group.bankName);
  }
  return {
    ...plan,
    groups,
    pages: plan.pages.map(page => ({
      ...page,
      assignedBankName: bankByPage.get(page.page) || '待确认银行'
    }))
  };
}

const StrategySummary: React.FC<{
  label: string;
  groups: PdfBankSplitPlan['groups'];
  message?: string;
}> = ({ label, groups, message }) => (
  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
    {groups.length > 0 ? (
      <div className="mt-1.5 space-y-1 text-[11px] text-slate-700">
        {groups.slice(0, 6).map(group => (
          <div key={group.id} className="flex items-center justify-between gap-3">
            <span className="truncate" title={group.bankName}>{group.bankName}</span>
            <span className="flex-shrink-0 font-mono text-slate-500">第 {group.pageSelection} 页</span>
          </div>
        ))}
        {groups.length > 6 && <div className="text-slate-400">另有 {groups.length - 6} 个区间…</div>}
      </div>
    ) : (
      <div className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{message || '正在生成对照方案…'}</div>
    )}
  </div>
);

export const Step1Upload: React.FC<Step1Props> = ({
  caseId,
  caseRespondentName,
  accounts,
  transactions,
  onDataUpdated,
  onNext,
  onPrev
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressInfo, setProgressInfo] = useState<GeminiProgressInfo | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [isCancellable, setIsCancellable] = useState(false);
  const [importTasks, setImportTasks] = useState<ImportTask[]>([]);
  const [pendingPdfPlans, setPendingPdfPlans] = useState<PdfBankSplitPlan[]>([]);
  const [splitValidationErrors, setSplitValidationErrors] = useState<Record<string, string[]>>({});
  const [copiedReport, setCopiedReport] = useState<'TASKS' | 'ANOMALIES' | ''>('');

  const abortControllerRef = useRef<AbortController | null>(null);
  const mineruControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingPdfPlansRef = useRef<PdfBankSplitPlan[]>([]);
  const zeroTransactionFiles = sourceFilesWithoutTransactions(accounts, transactions);
  const sourceTransactionCounts = transactionCountsBySource(transactions);
  const hasTransactions = transactions.length > 0;
  const visibleAccounts = businessAccounts(accounts);
  const importedFileGroups = Array.from(accounts.reduce((groups, account) => {
    const key = sourceIdentity(account);
    const current = groups.get(key) || [];
    current.push(account);
    groups.set(key, current);
    return groups;
  }, new Map<string, BankAccount[]>()).entries());

  const updateImportTask = (id: string, patch: Partial<ImportTask>) => {
    setImportTasks(current => current.map(task => task.id === id ? { ...task, ...patch } : task));
  };

  const copyReport = async (kind: 'TASKS' | 'ANOMALIES') => {
    const text = kind === 'TASKS'
      ? formatImportTasksForCopy(importTasks)
      : formatRecognitionDiagnostics(accounts, transactions);
    try {
      await copyText(text);
      setCopiedReport(kind);
      window.setTimeout(() => setCopiedReport(''), 2500);
    } catch {
      setErrorMessage('浏览器未允许复制，请检查剪贴板权限后重试。');
    }
  };

  useEffect(() => {
    if (!isProcessing) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [isProcessing]);

  useEffect(() => {
    pendingPdfPlansRef.current = pendingPdfPlans;
  }, [pendingPdfPlans]);

  useEffect(() => () => {
    pendingPdfPlansRef.current.forEach(releasePdfSplitPlanPreviews);
    mineruControllersRef.current.forEach(controller => controller.abort());
  }, []);

  useEffect(() => {
    publishAutomationImportState({
      isProcessing,
      statusText,
      progress: progressInfo ? {
        percent: progressInfo.percent,
        totalTransactions: progressInfo.totalTransactions,
        statusText: progressInfo.statusText,
        currentBank: progressInfo.currentBank
      } : null,
      tasks: importTasks.map(task => ({
        id: task.id,
        fileName: task.file.name,
        status: task.status,
        title: task.title,
        message: task.message,
        impact: task.impact,
        details: task.details,
        transactionCount: task.transactionCount,
        accountCount: task.accountCount,
        diagnosticCode: task.diagnosticCode,
        diagnosis: task.diagnosis
      })),
      pdfSplitPlans: pendingPdfPlans.map(plan => ({
        fileName: plan.sourceFile.name,
        totalPages: plan.totalPages,
        groups: plan.groups.map(group => ({ bankName: group.bankName, pageSelection: group.pageSelection })),
        pages: plan.pages.map(page => ({
          page: page.page,
          pageType: page.pageType,
          bankName: page.assignedBankName,
          selectedForRecognition: page.selectedForRecognition
        })),
        validationErrors: splitValidationErrors[plan.id] || []
      }))
    });
  }, [isProcessing, statusText, progressInfo, importTasks, pendingPdfPlans, splitValidationErrors]);

  const handleCancelProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStatusText('正在停止当前文件解析…');
  };

  const processFiles = async (files: FileList | File[], forceFresh = false) => {
    if (isProcessing) {
      setErrorMessage('当前文件仍在处理中，请等待完成或停止后再添加文件。');
      return;
    }
    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    setImportTasks(current => {
      const next = new Map(current.map(task => [task.id, task]));
      for (const file of fileList) {
        const id = importTaskId(file);
        next.set(id, { id, file, status: 'QUEUED', title: `等待识别“${file.name}”` });
      }
      return [...next.values()];
    });

    setIsProcessing(true);
    setErrorMessage(null);
    setResumeNotice(null);
    setProgressInfo(null);
    setStatusText(null);

    const newAccounts = [...accounts];
    const newTransactions = [...transactions];
    let wasCancelled = false;

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const name = file.name.toLowerCase();
      const taskId = importTaskId(file);
      updateImportTask(taskId, {
        status: 'PROCESSING',
        title: `正在识别“${file.name}”`,
        message: '识别完成前请保持当前页面打开。',
        impact: undefined,
        details: undefined,
        retryable: undefined
      });

      try {
        let importedTransactionCount = 0;
        let importedAccountCount = 0;
        let incompletePages: number[] = [];
        let sourceStorageWarning = false;
        setStatusText(`正在校验原始文件“${file.name}”…`);
        const source = await identifySourceDocument(file);
        const extractionRun = createExtractionRun(source.documentId);
        const removePreviousVersion = () => {
          for (let index = newAccounts.length - 1; index >= 0; index -= 1) {
            const existing = newAccounts[index];
            const sameSource = existing.sourceDocumentId
              ? existing.sourceDocumentId === source.documentId
              : existing.fileName === file.name;
            if (sameSource) newAccounts.splice(index, 1);
          }
          for (let index = newTransactions.length - 1; index >= 0; index -= 1) {
            const existing = newTransactions[index];
            const sameSource = existing.sourceDocumentId
              ? existing.sourceDocumentId === source.documentId
              : existing.rawSourceFile === file.name;
            if (sameSource) newTransactions.splice(index, 1);
          }
        };
        if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
          setStatusText(`正在读取电子流水“${file.name}”…`);
          const { account, accounts: parsedAccounts, transactions: parsedTx } = await parseExcelBankStatement(file);
          try {
            await saveSourceDocument(caseId, file, source);
          } catch (storageError) {
            sourceStorageWarning = true;
            console.warn('Source document storage unavailable; continuing recognition', storageError);
          }
          const annotated = attachSourceProvenance(parsedAccounts || [account], parsedTx, source, extractionRun);
          const canonical = normalizeRecognizedData(annotated.accounts, annotated.transactions);
          removePreviousVersion();
          newAccounts.push(...canonical.accounts);
          newTransactions.push(...canonical.transactions);
          importedTransactionCount = canonical.transactions.length;
          importedAccountCount = businessAccounts(canonical.accounts).length;
        } else if (name.endsWith('.pdf')) {
          const controller = new AbortController();
          abortControllerRef.current = controller;
          setIsCancellable(true);
          if (forceFresh) {
            try { await clearRecognitionCheckpoints(caseId, file.name, source.documentId); }
            catch { setResumeNotice('旧进度未能清除，但本次会忽略旧进度，从头识别。'); }
          }
          // Read the document once, organize individual pages, retain evidence,
          // and validate without guessing changes to extracted financial fields.
          const { accounts: parsedAccounts, transactions: parsedTx } = await parsePdfWithMinerU(
            file,
            (info: GeminiProgressInfo) => {
              setProgressInfo(info);
              if (info.statusText) setStatusText(info.statusText);
            },
            controller.signal,
            {
              respondentName: caseRespondentName,
              resumeStore: createRecognitionCheckpointStore(caseId, source.documentId, file.name, caseRespondentName || ''),
              forceFresh,
              onResumeWarning: setResumeNotice,
              onPageCheckpoint: checkpoint => publishRecognitionCheckpoint(checkpoint, {
                documentId: source.documentId, runId: extractionRun.id,
                fileName: file.name, totalPages: checkpoint.selected.totalPages
              })
            }
          );
          let sourceStored = true;
          try {
            // Replace the retained original only after recognition succeeds, so a
            // failed same-name retry cannot leave old rows pointing at a new PDF.
            await saveSourceDocument(caseId, file, source);
          } catch (storageError) {
            sourceStored = false;
            sourceStorageWarning = true;
            console.warn('Source document storage unavailable; continuing recognition', storageError);
          }
          const annotated = attachSourceProvenance(parsedAccounts, parsedTx, source, extractionRun);
          const canonical = normalizeRecognizedData(annotated.accounts, annotated.transactions);
          removePreviousVersion();
          newAccounts.push(...canonical.accounts.map(account => sourceStored ? account : {
            ...account,
            parseStatus: account.parseStatus === 'INCOMPLETE' ? 'INCOMPLETE' as const : 'NEEDS_REVIEW' as const,
            parseWarnings: [...new Set([...(account.parseWarnings || []), '原始文件未能持久保存，请在本次会话中完成原件核对或重新上传'])]
          }));
          newTransactions.push(...canonical.transactions);
          importedTransactionCount = canonical.transactions.length;
          importedAccountCount = businessAccounts(canonical.accounts).length;
          incompletePages = incompleteRecognitionPages(canonical.accounts);
        } else {
          throw new Error('不支持的文件格式');
        }
        updateImportTask(taskId, importedTransactionCount === 0 ? {
          status: 'EMPTY',
          title: `“${file.name}”未发现流水`,
          message: '请确认原件是否确实没有交易明细，或检查页面方向和清晰度后重新识别。',
          impact: '文件中的账户信息已保留，但不会计入后续资金分析。',
          retryable: true,
          transactionCount: 0,
          accountCount: importedAccountCount
        } : incompletePages.length ? {
          status: 'WARNING',
          title: `“${file.name}”仅完成部分识别`,
          message: `已保留 ${importedTransactionCount} 笔流水和 ${importedAccountCount} 个账户，但仍有 ${incompletePages.length} 页未能可靠识别。`,
          impact: `未完成页面：第 ${incompletePages.join('、')} 页。请点击“继续未完成页”补齐；补齐或人工录入前不能进入资金分析。`,
          retryable: true,
          transactionCount: importedTransactionCount,
          accountCount: importedAccountCount,
          diagnosticCode: 'PDF_INCOMPLETE_PAGES',
          diagnosis: '这些页面尚未完整读取。点击“继续未完成页”会读取本机保存的进度，补齐失败或仍需复核的页面；如怀疑原文提取有问题，可选择“从头识别”。'
        } : sourceStorageWarning ? {
          status: 'WARNING',
          title: `“${file.name}”已导入，但原件未保存`,
          message: `已读取 ${importedTransactionCount} 笔流水，但浏览器未能保存原始文件。`,
          impact: '交易可以继续分析，但刷新页面后可能无法打开原件对照。建议释放浏览器存储空间后重新上传。',
          retryable: true,
          transactionCount: importedTransactionCount,
          accountCount: importedAccountCount
        } : {
          status: 'SUCCESS',
          title: `“${file.name}”已导入`,
          message: `共读取 ${importedTransactionCount} 笔流水，识别出 ${importedAccountCount} 个账户。`,
          transactionCount: importedTransactionCount,
          accountCount: importedAccountCount
        });
      } catch (err: any) {
        if (err.name === 'AbortError' || err.message?.includes('停止')) {
          console.log('User cancelled parsing:', file.name);
          updateImportTask(taskId, {
            status: 'CANCELLED',
            title: `已停止识别“${file.name}”`,
            message: '该文件没有导入，案件中原有数据未受影响。',
            retryable: true
          });
          for (const unprocessed of fileList.slice(i + 1)) {
            updateImportTask(importTaskId(unprocessed), {
              status: 'CANCELLED',
              title: `尚未识别“${unprocessed.name}”`,
              message: '本批次已停止，可以单独重新识别该文件。',
              retryable: true
            });
          }
          wasCancelled = true;
          break;
        }
        console.error('Error processing file:', file.name, err);
        const friendly = importErrorForUser(err, file.name);
        updateImportTask(taskId, {
          status: 'ERROR',
          title: friendly.title,
          message: friendly.message,
          impact: friendly.impact,
          details: friendly.details,
          retryable: friendly.retryable,
          diagnosticCode: friendly.diagnosticCode,
          diagnosis: friendly.diagnosis
        });
      } finally {
        abortControllerRef.current = null;
        setIsCancellable(false);
      }
    }

    setIsProcessing(false);
    setProgressInfo(null);
    setStatusText(wasCancelled ? '已停止解析，未完成的文件没有导入。' : null);
    onDataUpdated(newAccounts, newTransactions);
  };

  const startMineruComparison = (file: File, plan: PdfBankSplitPlan) => {
    mineruControllersRef.current.get(plan.id)?.abort();
    const controller = new AbortController();
    mineruControllersRef.current.set(plan.id, controller);
    void (async () => {
      try {
        const mineruPageMap = await discoverPdfPageMapWithMinerU(file, plan.totalPages, progress => {
          setPendingPdfPlans(current => current.map(item => item.id !== plan.id ? item : {
            ...item,
            comparison: item.comparison ? {
              ...item.comparison,
              mineruStatus: 'PROCESSING',
              mineruMessage: progress.message
            } : item.comparison
          }));
        }, controller.signal);
        const mineru = buildPdfBankSplitSuggestion('MINERU', mineruPageMap, plan);
        setPendingPdfPlans(current => current.map(item => item.id !== plan.id ? item : {
          ...item,
          comparison: {
            ...(item.comparison || {
              activeStrategy: 'CURRENT' as const,
              current: { strategy: 'CURRENT' as const, groups: item.groups, pages: item.pages }
            }),
            mineru,
            mineruStatus: 'READY' as const,
            mineruMessage: `MinerU 已形成 ${mineru.groups.length} 个连续银行区间`
          }
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        const coded = error as Error & { code?: string };
        const unavailable = coded.code === 'MINERU_NOT_CONFIGURED';
        const message = unavailable
          ? '尚未配置 MinerU 凭据；现有方案可正常使用'
          : `MinerU 对照失败：${error instanceof Error ? error.message : String(error)}`;
        setPendingPdfPlans(current => current.map(item => item.id !== plan.id ? item : {
          ...item,
          comparison: {
            ...(item.comparison || {
              activeStrategy: 'CURRENT' as const,
              current: { strategy: 'CURRENT' as const, groups: item.groups, pages: item.pages }
            }),
            mineruStatus: unavailable ? 'UNAVAILABLE' as const : 'ERROR' as const,
            mineruMessage: message
          }
        }));
      } finally {
        if (mineruControllersRef.current.get(plan.id) === controller) mineruControllersRef.current.delete(plan.id);
      }
    })();
  };

  const preparePdfPlans = async (files: File[]) => {
    if (!files.length) return;
    setIsProcessing(true);
    setErrorMessage(null);
    setProgressInfo(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsCancellable(true);
    try {
      for (const [fileIndex, file] of files.entries()) {
        setStatusText(`正在扫描“${file.name}”的银行和页码…`);
        const plan = await preparePdfBankSplitPlan(file, (message, completedPages, totalPages) => {
          const fileBase = fileIndex / files.length;
          const fileProgress = totalPages ? completedPages / totalPages / files.length : 0;
          setProgressInfo({
            statusText: message,
            totalTransactions: 0,
            percent: Math.min(99, Math.round((fileBase + fileProgress) * 100)),
            isStreaming: true
          });
          setStatusText(message);
        }, controller.signal);
        setPendingPdfPlans(current => {
          const next = new Map(current.map(item => [item.id, item]));
          const previous = next.get(plan.id);
          if (previous) releasePdfSplitPlanPreviews(previous);
          next.set(plan.id, plan);
          return [...next.values()];
        });
        startMineruComparison(file, plan);
      }
    } catch (error) {
      if (controller.signal.aborted) setStatusText('已停止 PDF 分拣，尚未开始识别。');
      else setErrorMessage(`PDF 分拣失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      abortControllerRef.current = null;
      setIsCancellable(false);
      setIsProcessing(false);
      setProgressInfo(null);
      if (!controller.signal.aborted) setStatusText(null);
    }
  };

  const selectPdfStrategy = (planId: string, strategy: 'CURRENT' | 'MINERU') => {
    setPendingPdfPlans(current => current.map(plan => {
      if (plan.id !== planId || !plan.comparison || plan.comparison.activeStrategy === strategy) return plan;
      const activeSnapshot = {
        strategy: plan.comparison.activeStrategy,
        groups: plan.groups,
        pages: plan.pages
      };
      const comparison = {
        ...plan.comparison,
        current: plan.comparison.activeStrategy === 'CURRENT' ? activeSnapshot : plan.comparison.current,
        mineru: plan.comparison.activeStrategy === 'MINERU' ? activeSnapshot : plan.comparison.mineru,
        activeStrategy: strategy
      };
      const target = strategy === 'CURRENT' ? comparison.current : comparison.mineru;
      if (!target) return plan;
      return { ...plan, groups: target.groups, pages: target.pages, comparison };
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const handleFiles = async (files: FileList | File[]) => {
    if (isProcessing) {
      setErrorMessage('当前文件仍在处理中，请等待完成或停止后再添加文件。');
      return;
    }
    // MinerU direct trial: PDFs no longer stop at the page-classification
    // timeline. The legacy preparation functions below remain available for a
    // quick rollback, but are not part of the active upload path.
    await processFiles(Array.from(files));
  };

  const updatePdfGroup = (planId: string, groupId: string, patch: { bankName?: string; pageSelection?: string }) => {
    setPendingPdfPlans(current => current.map(plan => {
      if (plan.id !== planId) return plan;
      const groups = plan.groups.map(group => group.id === groupId ? { ...group, ...patch } : group);
      return withSyncedPdfAssignments(plan, groups);
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const updatePdfPageType = (
    planId: string,
    pageNumber: number,
    pageType: PdfPageClassification['pageType']
  ) => {
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      pages: plan.pages.map(page => {
        if (page.page !== pageNumber) return page;
        const suggestedForRecognition = isPageRecommendedForRecognition(pageType);
        return {
          ...page,
          pageType,
          suggestedForRecognition,
          selectedForRecognition: page.selectionModifiedByUser
            ? page.selectedForRecognition
            : suggestedForRecognition
        };
      })
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const togglePdfPageSelection = (planId: string, pageNumber: number) => {
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      pages: plan.pages.map(page => page.page === pageNumber ? {
        ...page,
        selectedForRecognition: !page.selectedForRecognition,
        selectionModifiedByUser: true
      } : page)
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const applySuggestedPageSelection = (planId: string, pageNumbers?: number[]) => {
    const targetPages = pageNumbers ? new Set(pageNumbers) : null;
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      pages: plan.pages.map(page => !targetPages || targetPages.has(page.page) ? {
        ...page,
        selectedForRecognition: page.suggestedForRecognition,
        selectionModifiedByUser: false
      } : page)
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const updatePdfBoundary = (planId: string, boundaryIndex: number, leftEndPage: number) => {
    setPendingPdfPlans(current => current.map(plan => {
      if (plan.id !== planId) return plan;
      const left = plan.groups[boundaryIndex];
      const right = plan.groups[boundaryIndex + 1];
      if (!left || !right) return plan;
      const leftPages = pdfGroupPages(left, plan.totalPages);
      const rightPages = pdfGroupPages(right, plan.totalPages);
      const start = leftPages[0];
      const end = rightPages.at(-1);
      if (!start || !end || end <= start) return plan;
      const boundary = Math.max(start, Math.min(end - 1, Math.round(leftEndPage)));
      const nextLeftPages = continuousPages(start, boundary);
      const nextRightPages = continuousPages(boundary + 1, end);
      const groups = plan.groups.map((group, index) => {
        if (index === boundaryIndex) return { ...group, pages: nextLeftPages, pageSelection: formatPageSelection(nextLeftPages) };
        if (index === boundaryIndex + 1) return { ...group, pages: nextRightPages, pageSelection: formatPageSelection(nextRightPages) };
        return group;
      });
      return withSyncedPdfAssignments(plan, groups);
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const splitPdfGroupAtPage = (planId: string, pageNumber: number) => {
    setPendingPdfPlans(current => current.map(plan => {
      if (plan.id !== planId) return plan;
      const groupIndex = plan.groups.findIndex(group => pdfGroupPages(group, plan.totalPages).includes(pageNumber));
      if (groupIndex < 0) return plan;
      const group = plan.groups[groupIndex];
      const pages = pdfGroupPages(group, plan.totalPages);
      const start = pages[0];
      const end = pages.at(-1);
      if (!start || !end || pageNumber <= start || pageNumber > end) return plan;
      const leftPages = continuousPages(start, pageNumber - 1);
      const rightPages = continuousPages(pageNumber, end);
      const left = { ...group, pages: leftPages, pageSelection: formatPageSelection(leftPages) };
      const right = {
        ...group,
        id: `MANUAL_${Date.now()}_${pageNumber}`,
        pages: rightPages,
        pageSelection: formatPageSelection(rightPages),
        suggestedBankName: group.bankName,
        boundaryBasis: 'MANUAL' as const,
        documentLabel: ''
      };
      left.boundaryBasis = 'MANUAL';
      const groups = [...plan.groups.slice(0, groupIndex), left, right, ...plan.groups.slice(groupIndex + 1)];
      return withSyncedPdfAssignments(plan, groups);
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const removePdfGroup = (planId: string, groupId: string) => {
    setPendingPdfPlans(current => current.map(plan => {
      if (plan.id !== planId || plan.groups.length <= 1) return plan;
      const groupIndex = plan.groups.findIndex(group => group.id === groupId);
      if (groupIndex < 0) return plan;
      const targetPages = pdfGroupPages(plan.groups[groupIndex], plan.totalPages);
      const mergeIndex = groupIndex > 0 ? groupIndex - 1 : 1;
      const mergePages = pdfGroupPages(plan.groups[mergeIndex], plan.totalPages);
      const combined = [...new Set([...targetPages, ...mergePages])].sort((left, right) => left - right);
      const groups = plan.groups
        .filter((_, index) => index !== groupIndex)
        .map(group => group.id === plan.groups[mergeIndex].id
          ? { ...group, pages: combined, pageSelection: formatPageSelection(combined) }
          : group);
      return withSyncedPdfAssignments(plan, groups);
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const discardPdfPlan = (planId: string) => {
    mineruControllersRef.current.get(planId)?.abort();
    mineruControllersRef.current.delete(planId);
    setPendingPdfPlans(current => {
      current.filter(plan => plan.id === planId).forEach(releasePdfSplitPlanPreviews);
      return current.filter(plan => plan.id !== planId);
    });
    setSplitValidationErrors(current => {
      const next = { ...current };
      delete next[planId];
      return next;
    });
  };

  const confirmPdfPlans = async () => {
    const errors = Object.fromEntries(pendingPdfPlans.map(plan => [
      plan.id,
      validateBankGroups(plan.groups, plan.totalPages, plan.pages)
    ]));
    setSplitValidationErrors(errors);
    if (Object.values(errors).some(items => items.length)) {
      setErrorMessage('分拣方案仍有未确认、漏页或重复页，请按红色提示修改后再开始识别。');
      return;
    }
    mineruControllersRef.current.forEach(controller => controller.abort());
    mineruControllersRef.current.clear();
    setErrorMessage(null);
    setIsProcessing(true);
    setStatusText('正在生成各银行独立 PDF…');
    try {
      const splitFiles: File[] = [];
      for (const plan of pendingPdfPlans) splitFiles.push(...await createBankSplitFiles(plan));
      pendingPdfPlans.forEach(releasePdfSplitPlanPreviews);
      setPendingPdfPlans([]);
      setSplitValidationErrors({});
      setIsProcessing(false);
      setStatusText(null);
      await processFiles(splitFiles);
    } catch (error) {
      setIsProcessing(false);
      setStatusText(null);
      setErrorMessage(`无法生成银行分文件：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isProcessing) {
      setErrorMessage('当前文件仍在处理中，请等待完成或停止后再添加文件。');
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleRemoveSourceFile = async (sourceKey: string, fileName: string) => {
    const sourceAccounts = accounts.filter(account => sourceIdentity(account) === sourceKey);
    if (!sourceAccounts.length) return;
    const sourceAccountCount = businessAccounts(sourceAccounts).length;
    if (!window.confirm(`确定删除来源文件“${fileName}”及其识别出的 ${sourceAccountCount} 个账户吗？重新上传时将从头识别。`)) return;
    const updatedAccounts = accounts.filter(account => sourceIdentity(account) !== sourceKey);
    const updatedTransactions = transactions.filter(transaction => transaction.sourceDocumentId
      ? sourceIdentity(transaction) !== sourceKey
      : transaction.rawSourceFile
        ? transaction.rawSourceFile !== fileName
        : !sourceAccounts.some(account => transactionBelongsToAccount(transaction, account)));
    await deleteSourceDocument(caseId, fileName, sourceAccounts[0].sourceDocumentId);
    onDataUpdated(updatedAccounts, updatedTransactions);
    setStatusText(`已删除 ${fileName} 的识别结果`);
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      {/* Step Header */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
            Step 1 / 6 证据上传
          </span>

          <div className="flex items-center space-x-2">
            <span className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-xs font-medium">
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              <span>MinerU 直接结构化提取</span>
            </span>

            <span className="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-medium">
              <ShieldCheck className="w-3 h-3 text-emerald-600" />
              <span>原 PDF 直传 · 无需预分档</span>
            </span>
          </div>
        </div>

        <h1 className="text-2xl font-bold text-slate-900 mt-3">
          上传银行流水证据文件
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Excel/CSV 会直接读取；PDF 当前直接交给 MinerU 提取账户与流水，不再预先分类或切分银行。完成后请对照原件复核。
        </p>
      </div>

      {/* Upload Zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`relative border-2 border-dashed rounded-2xl p-10 text-center transition-all bg-white shadow-sm ${
          isDragging
            ? 'border-blue-500 bg-blue-50/50 scale-[1.005]'
            : 'border-slate-300 hover:border-slate-400'
        }`}
      >
        <input
          type="file"
          id="file-upload"
          multiple
          accept=".xlsx,.xls,.csv,.pdf"
          onChange={(event) => {
            const selectedFiles = event.currentTarget.files
              ? Array.from(event.currentTarget.files)
              : [];
            event.currentTarget.value = '';
            if (selectedFiles.length) handleFiles(selectedFiles);
          }}
          className="hidden"
          disabled={isProcessing}
        />

        <div className="flex flex-col items-center justify-center space-y-4">
          <div className={`p-4 rounded-full transition-transform ${isDragging ? 'bg-blue-100 scale-110' : 'bg-slate-100'}`}>
            <UploadCloud className={`w-10 h-10 ${isDragging ? 'text-blue-600' : 'text-slate-500'}`} />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="file-upload"
              className="text-base font-semibold text-blue-600 hover:text-blue-700 cursor-pointer hover:underline"
            >
              点击选择文件
            </label>
            <span className="text-slate-600 text-base"> 或直接拖拽文件到这里</span>
            <p className="text-xs text-slate-400 mt-1">
              支持格式：.xlsx、.xls、.csv、.pdf（识别完成后可按原件页码核对）
            </p>
          </div>

          {isProcessing && (
            <div className="w-full max-w-lg bg-blue-50/90 border border-blue-200 rounded-2xl p-5 text-left space-y-3 mt-4 shadow-sm">
              <div className="flex items-center justify-between text-blue-900 font-semibold text-sm">
                <div className="flex items-center space-x-2">
                  <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  <span className="truncate">{statusText || '正在准备识别文件...'}</span>
                </div>
                <div className="flex items-center space-x-2">
                  {progressInfo && (
                    <span className="text-xs font-mono font-bold text-blue-700 bg-blue-100/80 px-2 py-0.5 rounded-full flex-shrink-0">
                      {progressInfo.percent}%
                    </span>
                  )}
                  {isCancellable && (
                    <button
                      type="button"
                      onClick={handleCancelProcessing}
                      className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-600 text-xs font-medium transition shadow-xs"
                      title="中止当前识别任务"
                    >
                      <StopCircle className="w-3.5 h-3.5" />
                      <span>停止</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Real-time Streaming Progress Bar */}
              {progressInfo && (
                <div className="space-y-2">
                  <div className="w-full h-2.5 bg-blue-200/60 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-600 to-indigo-600 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${Math.max(progressInfo.percent, 3)}%` }}
                    />
                  </div>
                  <div className="flex justify-between items-center text-[11px] text-slate-600 font-medium pt-0.5">
                    <div className="flex items-center space-x-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                      <span><strong>MinerU 正在解析原始文件</strong></span>
                      {progressInfo.currentBank && (
                        <span className="ml-1 px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 text-[10px] font-semibold">
                          {progressInfo.currentBank}
                        </span>
                      )}
                    </div>
                    <span>
                      当前已读取约：<strong className="text-emerald-700 text-xs">{progressInfo.totalTransactions}</strong> 笔
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <div role="status" className="flex items-center space-x-2 text-amber-800 bg-amber-50 border border-amber-200 px-4 py-2 rounded-xl text-xs mt-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>
      </div>

      {pendingPdfPlans.length > 0 && (
        <div className="bg-white rounded-2xl border border-blue-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 bg-blue-50/80 border-b border-blue-200 flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-blue-100 text-blue-700">
                <Scissors className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">确认 PDF 页面时间线</h2>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  先在剪辑式时间线上调整银行区间和识别范围；点击页面帧后，下方同步显示对应的原始 PDF 单页。
                </p>
              </div>
            </div>
            <span className="text-[11px] font-medium text-blue-700 bg-white border border-blue-200 rounded-full px-2.5 py-1 flex-shrink-0">
              待确认 {pendingPdfPlans.length} 个原文件
            </span>
          </div>

          <div className="p-5 space-y-5">
            {pendingPdfPlans.map(plan => {
              const planErrors = splitValidationErrors[plan.id] || [];
              return (
                <section key={plan.id} className="rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate" title={plan.sourceFile.name}>{plan.sourceFile.name}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        共 {plan.totalPages} 页 · 系统建议 {plan.groups.length} 个连续银行区间
                        {plan.groups.some(group => group.boundaryBasis === 'MODEL_BANK') ? ' · 模型已判断银行切换位置' : ' · 暂按逐页银行证据分档'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => discardPdfPlan(plan.id)}
                      disabled={isProcessing}
                      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600 px-2 py-1.5 rounded-lg hover:bg-rose-50 disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      移除
                    </button>
                  </div>

                  <div className="p-4 space-y-3">
                    {plan.comparison && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div>
                            <div className="text-xs font-semibold text-slate-800">分档方案对比</div>
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                              两套方案只负责判断页面类型和银行切换位置；确认后仅采用当前选中的一套进入流水识别。
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => selectPdfStrategy(plan.id, 'CURRENT')}
                              className={`rounded-lg border px-3 py-2 text-left text-[11px] transition ${plan.comparison.activeStrategy === 'CURRENT'
                                ? 'border-blue-500 bg-blue-50 text-blue-800 shadow-sm'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'}`}
                            >
                              <span className="block font-semibold">现有视觉方案</span>
                              <span className="mt-0.5 block">{plan.comparison.current.groups.length} 个区间</span>
                            </button>
                            <button
                              type="button"
                              disabled={isProcessing || plan.comparison.mineruStatus !== 'READY'}
                              onClick={() => selectPdfStrategy(plan.id, 'MINERU')}
                              className={`rounded-lg border px-3 py-2 text-left text-[11px] transition disabled:cursor-not-allowed disabled:opacity-60 ${plan.comparison.activeStrategy === 'MINERU'
                                ? 'border-emerald-500 bg-emerald-50 text-emerald-800 shadow-sm'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}
                            >
                              <span className="block font-semibold">MinerU 结构化方案</span>
                              <span className="mt-0.5 block">
                                {plan.comparison.mineruStatus === 'READY'
                                  ? `${plan.comparison.mineru?.groups.length || 0} 个区间`
                                  : plan.comparison.mineruStatus === 'PROCESSING' ? '正在生成…' : '暂不可用'}
                              </span>
                            </button>
                          </div>
                        </div>
                        <div className="mt-3 grid gap-2 md:grid-cols-2">
                          <StrategySummary
                            label="现有视觉方案"
                            groups={plan.comparison.activeStrategy === 'CURRENT' ? plan.groups : plan.comparison.current.groups}
                          />
                          <StrategySummary
                            label="MinerU 结构化方案"
                            groups={plan.comparison.activeStrategy === 'MINERU' ? plan.groups : plan.comparison.mineru?.groups || []}
                            message={plan.comparison.mineruMessage}
                          />
                        </div>
                      </div>
                    )}
                    <PdfTimelineEditor
                      plan={plan}
                      disabled={isProcessing}
                      onGroupChange={(groupId, patch) => updatePdfGroup(plan.id, groupId, patch)}
                      onBoundaryChange={(boundaryIndex, leftEndPage) => updatePdfBoundary(plan.id, boundaryIndex, leftEndPage)}
                      onRemoveGroup={groupId => removePdfGroup(plan.id, groupId)}
                      onSplitAtPage={pageNumber => splitPdfGroupAtPage(plan.id, pageNumber)}
                      onPageTypeChange={(pageNumber, pageType) => updatePdfPageType(plan.id, pageNumber, pageType)}
                      onTogglePageSelection={pageNumber => togglePdfPageSelection(plan.id, pageNumber)}
                      onApplySuggestedSelection={() => applySuggestedPageSelection(plan.id)}
                    />
                    {planErrors.length > 0 && (
                      <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-900 space-y-1">
                        {planErrors.map(error => <div key={error}>• {error}</div>)}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
              <p className="text-[11px] text-slate-500 leading-relaxed">
                确认时会检查 1 到末页是否全部归类、没有重复且每段连续。同一银行在后文再次出现时仍保留为新的连续页段；只有勾选的原生 PDF 页面进入识别，不会把缩略图当作识别原件。
              </p>
              <button
                type="button"
                onClick={confirmPdfPlans}
                disabled={isProcessing || pendingPdfPlans.length === 0}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-sm disabled:opacity-50 flex-shrink-0"
              >
                <CheckCircle2 className="w-4 h-4" />
                确认分拣并开始识别
              </button>
            </div>
          </div>
        </div>
      )}

      {zeroTransactionFiles.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold">
              {zeroTransactionFiles.length} 个文件未识别到流水明细
            </div>
            <p className="text-xs mt-1 leading-relaxed">
              这些文件已保留，但不会计入后续资金分析，也不能单独进入下一步。请确认原件是否确实无交易；如有流水，请选择“从头识别”，或删除后上传更清晰的文件。
            </p>
            <p className="text-[11px] mt-2 text-amber-800 break-all">
              {zeroTransactionFiles.join('、')}
            </p>
          </div>
        </div>
      )}

      {importTasks.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">本次文件处理结果</h2>
              <p className="text-[11px] text-slate-500 mt-1">每个文件单独处理；某个文件失败不会影响其他文件或案件中已有数据。</p>
            </div>
            <button
              type="button"
              onClick={() => copyReport('TASKS')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-[11px] font-medium flex-shrink-0"
            >
              {copiedReport === 'TASKS' ? <ClipboardCheck className="w-3.5 h-3.5 text-emerald-600" /> : <Clipboard className="w-3.5 h-3.5" />}
              {copiedReport === 'TASKS' ? '已复制' : '复制本次结果'}
            </button>
          </div>
          <div className="space-y-2">
            {importTasks.map(task => {
              const isFailure = task.status === 'ERROR';
              const isWarning = task.status === 'WARNING' || task.status === 'EMPTY';
              const isActive = task.status === 'PROCESSING' || task.status === 'QUEUED';
              return (
                <div
                  key={task.id}
                  role={isFailure ? 'alert' : undefined}
                  className={`rounded-xl border p-3 ${isFailure ? 'border-rose-200 bg-rose-50' : isWarning ? 'border-amber-200 bg-amber-50' : task.status === 'SUCCESS' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2 min-w-0">
                      {isActive ? (
                        <span className="mt-0.5 w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      ) : task.status === 'SUCCESS' ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 flex-shrink-0" />
                      ) : task.status === 'CANCELLED' ? (
                        <CircleSlash2 className="w-4 h-4 mt-0.5 text-slate-500 flex-shrink-0" />
                      ) : (
                        <AlertCircle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isFailure ? 'text-rose-600' : 'text-amber-600'}`} />
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 break-all">{task.title}</div>
                        {task.message && <p className="text-[11px] text-slate-700 mt-1 leading-relaxed">{task.message}</p>}
                        {task.impact && <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{task.impact}</p>}
                        {task.diagnosis && (
                          <div className="mt-2 rounded-lg border border-rose-200 bg-white/80 p-2 text-[11px] leading-relaxed text-rose-900">
                            <div className="font-semibold">具体诊断{task.diagnosticCode ? ` · ${task.diagnosticCode}` : ''}</div>
                            <div className="mt-1">{task.diagnosis}</div>
                          </div>
                        )}
                        {task.details && (
                          <details className="mt-2 text-[10px] text-slate-500">
                            <summary className="cursor-pointer select-none">查看错误详情</summary>
                            <div className="mt-1 rounded-lg bg-white/70 border border-slate-200 p-2 break-all font-mono">{task.details}</div>
                          </details>
                        )}
                      </div>
                    </div>
                    {task.retryable && !isActive && (
                      <div className="flex flex-col gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => task.file.type === 'application/pdf' || task.file.name.toLowerCase().endsWith('.pdf')
                          ? processFiles([task.file], task.status === 'EMPTY')
                          : handleFiles([task.file])}
                        disabled={isProcessing}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-[11px] font-medium disabled:opacity-50 flex-shrink-0"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        {task.file.name.toLowerCase().endsWith('.pdf') ? task.status === 'EMPTY' ? '从头识别' : '继续未完成页' : '重新识别'}
                      </button>
                      {task.file.name.toLowerCase().endsWith('.pdf') && task.status !== 'EMPTY' && (
                        <button type="button" disabled={isProcessing}
                          onClick={() => processFiles([task.file], true)}
                          className="text-[11px] text-slate-500 underline disabled:opacity-50">
                          从头识别（不使用上次进度）
                        </button>
                      )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {resumeNotice && <p role="status" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">{resumeNotice}</p>}

      {/* Uploaded Accounts List */}
      {accounts.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              <h2 className="text-base font-semibold text-slate-900">
                已导入文件 ({importedFileGroups.length}) · 账户 ({visibleAccounts.length})
              </h2>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-xs text-slate-500">
                共计 {transactions.length} 笔流水记录 · 数据保存在当前浏览器
              </span>
              <button
                type="button"
                onClick={() => copyReport('ANOMALIES')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-[11px] font-medium"
              >
                {copiedReport === 'ANOMALIES' ? <ClipboardCheck className="w-3.5 h-3.5 text-emerald-600" /> : <Clipboard className="w-3.5 h-3.5" />}
                {copiedReport === 'ANOMALIES' ? '已复制' : '复制全部识别异常'}
              </button>
            </div>
          </div>

          <div className="space-y-4">
            {importedFileGroups.map(([sourceKey, fileAccounts]) => {
              const firstAccount = fileAccounts[0];
              const fileName = firstAccount.fileName;
              const fileTransactionCount = sourceTransactionCounts.get(sourceKey) || 0;
              const fileTransactions = transactions.filter(transaction => sourceIdentity(transaction) === sourceKey);
              const isMinerUDirect = fileTransactions.some(transaction => transaction.extractionMethod === 'MINERU_DIRECT_PDF');
              const fileBusinessAccounts = fileAccounts.filter(account => !isDocumentReviewAccount(account));
              const reviewPages = incompleteRecognitionPages(fileAccounts);
              return (
                <section key={sourceKey} className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50/40">
                  <div className="flex items-center justify-between gap-3 px-4 py-3 bg-slate-100/80 border-b border-slate-200">
                    <div className="flex items-center gap-2 min-w-0">
                      {firstAccount.fileType === 'excel' || firstAccount.fileType === 'csv' ? (
                        <FileSpreadsheet className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                      ) : firstAccount.fileType === 'pdf' ? (
                        <FileText className="w-4 h-4 text-red-500 flex-shrink-0" />
                      ) : (
                        <FileImage className="w-4 h-4 text-blue-600 flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate" title={fileName}>{fileName}</p>
                        <p className="text-[11px] text-slate-500">
                          识别出 {fileBusinessAccounts.length} 个账户 · {fileTransactionCount} 笔流水
                          {isMinerUDirect ? ' · MinerU 提取 + 大模型整理' : ''}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveSourceFile(sourceKey, fileName)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition flex-shrink-0"
                      title="删除该来源文件及全部识别结果"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      删除文件
                    </button>
                  </div>
                  {reviewPages.length > 0 && (
                    <div className="mx-3 mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-900">
                      <span className="font-semibold">该文件尚未完整识别：</span>
                      第 {reviewPages.join('、')} 页仍需重新识别或人工补录，完成前不会进入正式资金分析。
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
                    {fileBusinessAccounts.map((acc) => (
                      <div
                        key={accountIdentityKey(acc)}
                        className="p-4 rounded-lg border border-slate-200 bg-white"
                      >
                        <div className="flex items-center space-x-2">
                          <span className="font-semibold text-slate-900 text-sm">{acc.bankName}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200/70 text-slate-700 font-mono">
                            {acc.accountNumber.slice(-4) ? `...${acc.accountNumber.slice(-4)}` : acc.accountNumber}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 mt-1">
                          户名: <span className="font-medium">{acc.accountName}</span>
                        </p>
                        <div className="flex items-center space-x-3 mt-2 text-[11px] text-slate-500 font-mono">
                          <span>入: <strong className="text-emerald-600 font-normal">¥{acc.totalIn.toLocaleString()}</strong></span>
                          <span>出: <strong className="text-rose-600 font-normal">¥{acc.totalOut.toLocaleString()}</strong></span>
                          <span>流水: {acc.transactionCount} 笔</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <div className="pt-2 flex justify-between items-center">
            <label
              htmlFor="file-upload"
              className="inline-flex items-center space-x-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium cursor-pointer"
            >
              <PlusCircle className="w-4 h-4" />
              <span>继续添加其他银行流水</span>
            </label>
          </div>
        </div>
      )}

      {/* Navigation Footer */}
      <div className="flex items-center justify-between pt-4">
        <button
          onClick={onPrev}
          disabled
          className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-xl border border-slate-200 text-slate-400 bg-slate-50 cursor-not-allowed text-sm font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>上一步</span>
        </button>

        <button
          onClick={onNext}
          disabled={!hasTransactions || isProcessing || pendingPdfPlans.length > 0}
          className={`inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl text-sm font-medium transition shadow-sm ${
            hasTransactions && !isProcessing && pendingPdfPlans.length === 0
              ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }`}
          title={pendingPdfPlans.length > 0
            ? '请先确认 PDF 分拣方案并完成识别'
            : !hasTransactions && accounts.length > 0
              ? '当前文件没有可分析的流水明细，请继续添加文件或核对原件'
              : undefined}
        >
          <span>{pendingPdfPlans.length > 0
            ? '请先确认 PDF 分拣方案'
            : !hasTransactions && accounts.length > 0
              ? '请先添加含流水明细的文件'
              : '下一步：核对原件'}</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
