import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Eye,
  FilePlus2,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  BankAccount,
  EvidenceReviewIssue,
  ReviewIssueStatus,
  StandardTransaction,
  TransactionEvidenceField,
} from "../types/transaction";
import { auditAccountBalance } from "../parsers/sanityChecker";
import { buildEvidenceReviewIssues } from "../review/buildEvidenceReviewIssues";
import { getSourceDocument } from "../store/sourceDocumentStore";
import { PdfEvidencePage } from "./PdfEvidencePage";
import {
  accountIdentityKey,
  transactionBelongsToAccount,
} from "../utils/accountIdentity";
import { createFieldEvidenceSnapshot } from "../utils/evidenceProvenance";
import { applyRowReviewDecision, RowReviewDecision } from "../review/fieldReview";
import { estimatedSourceRegion } from "../utils/sourceLocator";
import { isBlockingRecognitionIssue, isDocumentReviewAccount } from "../review/recognitionCompleteness";
import { formatRecognitionDiagnostics } from "../review/recognitionDiagnostics";
import { copyText } from "../utils/copyText";
import { buildReviewGroups, reviewDocumentKey, accountReviewLabel, EvidenceReviewGroup } from "../review/reviewGroups";
import { candidateReviewDescription } from "../review/candidateReview";

interface Step2Props {
  caseId: string;
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  onAccountsUpdated: (updated: BankAccount[]) => void;
  onTransactionsUpdated: (updated: StandardTransaction[]) => void;
  onNext: () => void;
  onPrev: () => void;
}

interface MissingTransactionDraft {
  accountKey: string;
  transactionTime: string;
  direction: "IN" | "OUT";
  amount: string;
  balance: string;
  counterpartyName: string;
  summary: string;
}

const EVIDENCE_FIELDS = new Set<TransactionEvidenceField>([
  "accountNumber", "accountName", "bankName", "transactionDate", "transactionType", "counterpartyBank", "transactionTime", "direction", "amount", "balance",
  "counterpartyName", "counterpartyAccount", "summary",
]);

function isEvidenceField(field: keyof StandardTransaction): field is TransactionEvidenceField {
  return EVIDENCE_FIELDS.has(field as TransactionEvidenceField);
}

function evidencePrimitive(value: unknown): string | number | null {
  return typeof value === "number" || typeof value === "string" || value === null
    ? value
    : String(value ?? "");
}

const emptyDraft = (accountKey = ""): MissingTransactionDraft => ({
  accountKey,
  transactionTime: "",
  direction: "OUT",
  amount: "",
  balance: "",
  counterpartyName: "",
  summary: "",
});

export const Step2Verify: React.FC<Step2Props> = ({
  caseId,
  accounts,
  transactions,
  onAccountsUpdated,
  onTransactionsUpdated,
  onNext,
  onPrev,
}) => {
  const [selectedAccNum, setSelectedAccNum] = useState(
    accounts[0] ? accountIdentityKey(accounts[0]) : "",
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [isSourceLoading, setIsSourceLoading] = useState(false);
  const [resolutionNote, setResolutionNote] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [draft, setDraft] = useState<MissingTransactionDraft>(emptyDraft());
  const [transactionFilter, setTransactionFilter] = useState<
    "ALL" | "PENDING" | "VERIFIED" | "CORRECTED" | "AUTO"
  >("ALL");
  const [expandedTransactionId, setExpandedTransactionId] = useState("");
  const [selectedTransactionId, setSelectedTransactionId] = useState("");
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [selectedRemovalIds, setSelectedRemovalIds] = useState<string[]>([]);
  const [confirmationChecks, setConfirmationChecks] = useState<string[]>([]);
  const [hasEditedReview, setHasEditedReview] = useState(false);
  const [reviewedRowIds, setReviewedRowIds] = useState<string[]>([]);
  const [unresolvedRowIds, setUnresolvedRowIds] = useState<string[]>([]);
  const [activeReviewRowIndex, setActiveReviewRowIndex] = useState(0);
  const [copyState, setCopyState] = useState<"IDLE" | "COPIED" | "ERROR">("IDLE");

  const selectedAccount =
    accounts.find(
      (account) => accountIdentityKey(account) === selectedAccNum,
    ) || accounts[0];
  const manualAccountOptions = selectedAccount ? accounts.filter(account => (
    !isDocumentReviewAccount(account)
    && (selectedAccount.sourceDocumentId
      ? account.sourceDocumentId === selectedAccount.sourceDocumentId
      : account.fileName === selectedAccount.fileName)
  )) : [];
  const defaultManualAccountKey = selectedAccount && !isDocumentReviewAccount(selectedAccount)
    ? accountIdentityKey(selectedAccount)
    : manualAccountOptions.length === 1 ? accountIdentityKey(manualAccountOptions[0]) : "";
  const auditReport = selectedAccount
    ? auditAccountBalance(selectedAccount, transactions)
    : null;
  const issues = useMemo(
    () =>
      selectedAccount
        ? accounts.filter(account => reviewDocumentKey(account) === reviewDocumentKey(selectedAccount))
          .flatMap(account => buildEvidenceReviewIssues(account, transactions))
        : [],
    [accounts, selectedAccount, transactions],
  );
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId);
  const selectedIssueGroup = selectedIssue
    ? issues.filter((issue) => sameReviewPage(issue, selectedIssue))
    : [];
  // Row-specific explanations live on the focused task card, not in a second
  // long checklist above it. Shared page notices are displayed only once.
  const pageReviewNotices = [...new Map(selectedIssueGroup.filter(issue => !isTransactionLevelIssue(issue))
    .map(issue => [`${issue.category}|${issue.description}`, issue])).values()];
  const affectedTransactionIds = [
    ...new Set(selectedIssueGroup.flatMap((issue) => issue.transactionIds)),
  ];
  const affectedTransactions = affectedTransactionIds
    .map((id) => transactions.find((transaction) => transaction.id === id))
    .filter(Boolean) as StandardTransaction[];
  const fieldIssueTransactionIds = new Set(selectedIssueGroup
    .filter(issue => issue.severity === "REQUIRED" && isTransactionLevelIssue(issue))
    .flatMap(issue => issue.transactionIds));
  const fieldIssueTransactions = affectedTransactions.filter(transaction => fieldIssueTransactionIds.has(transaction.id));
  const activeReviewTransaction = fieldIssueTransactions[activeReviewRowIndex] || fieldIssueTransactions[0];
  const allAccountIssues = useMemo(
    () =>
      accounts.flatMap((account) =>
        buildEvidenceReviewIssues(account, transactions),
      ),
    [accounts, transactions],
  );
  const allRequiredOutstanding = allAccountIssues.filter(
    (issue) =>
      issue.severity === "REQUIRED" &&
      (issue.status === "PENDING" || issue.status === "UNRESOLVED"),
  );
  const blockingRecognitionIssues = allAccountIssues.filter(isBlockingRecognitionIssue);
  const reviewQueueGroups = useMemo(
    () => buildReviewGroups(accounts, transactions),
    [accounts, transactions],
  );
  const pageLevelIssueGroups = reviewQueueGroups.filter((group) =>
    Boolean(group.pageNumber) && group.issues.some(isOutstandingRequired),
  );
  const documentAdvisoryGroups = reviewQueueGroups.filter((group) => (
    !group.pageNumber
    || (group.issues.some(issue => issue.severity === "ADVISORY")
      && !group.issues.some(issue => issue.severity === "REQUIRED"))
  ));
  const pendingReviewGroups = reviewQueueGroups.filter((group) =>
    group.issues.some(isOutstandingRequired),
  );
  const pendingReviewCount = pendingReviewGroups.length;
  const accountAuditMap = useMemo(() => new Map(
    accounts.map(account => [accountIdentityKey(account), auditAccountBalance(account, transactions)]),
  ), [accounts, transactions]);
  const unbalancedAccounts = accounts.filter(account => {
    const audit = accountAuditMap.get(accountIdentityKey(account));
    return Boolean(audit?.isAuditable && !audit.isBalanced);
  });
  const issuesByTransaction = useMemo(() => {
    const result = new Map<string, EvidenceReviewIssue[]>();
    for (const issue of allAccountIssues.filter(isTransactionLevelIssue))
      for (const transactionId of issue.transactionIds)
        result.set(transactionId, [
          ...(result.get(transactionId) || []),
          issue,
        ]);
    return result;
  }, [allAccountIssues]);
  const selectedTransaction = transactions.find(
    (transaction) => transaction.id === selectedTransactionId,
  );
  const sourceFocusTransaction = selectedIssue
    ? activeReviewTransaction || affectedTransactions[0]
    : selectedTransaction;
  const sourceFocusPageTransactions = sourceFocusTransaction
    ? transactions.filter(transaction => (
      transaction.rawPageNumber === sourceFocusTransaction.rawPageNumber
      && (sourceFocusTransaction.sourceDocumentId
        ? transaction.sourceDocumentId === sourceFocusTransaction.sourceDocumentId
        : transaction.rawSourceFile === sourceFocusTransaction.rawSourceFile)
    ))
    : [];
  const sourceFocusRegion = estimatedSourceRegion(sourceFocusTransaction, sourceFocusPageTransactions);
  const selectedCountComparison = selectedIssueGroup
    .map(issueCountComparison)
    .find(Boolean);
  const selectedIssueHasLocation =
    !selectedIssue ||
    (selectedCountComparison
      ? Boolean(selectedIssue.pageNumber && affectedTransactions.length > 0)
      : Boolean(selectedIssue.pageNumber || selectedTransaction));
  const confirmationItems = pageConfirmationItems(selectedIssueGroup, fieldIssueTransactions.length > 0);
  const rowReviewComplete = fieldIssueTransactions.every(transaction => reviewedRowIds.includes(transaction.id));
  const rowHandlingComplete = fieldIssueTransactions.every(transaction =>
    reviewedRowIds.includes(transaction.id) || unresolvedRowIds.includes(transaction.id));
  const confirmationComplete = rowReviewComplete
    && confirmationItems.every(item => confirmationChecks.includes(item));

  useEffect(() => {
    let cancelled = false;
    if (!selectedAccount || selectedAccount.fileType !== "pdf") {
      setSourceFile(null);
      return;
    }
    setIsSourceLoading(true);
    getSourceDocument(caseId, selectedAccount.fileName, selectedAccount.sourceDocumentId).then((file) => {
      if (!cancelled) {
        setSourceFile(file);
        setIsSourceLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [caseId, selectedAccount?.fileName, selectedAccount?.fileType, selectedAccount?.sourceDocumentId]);

  useEffect(() => {
    setResolutionNote(selectedIssue?.resolutionNote || "");
    setShowAddForm(false);
    setDraft(emptyDraft(defaultManualAccountKey));
    setSelectedRemovalIds([]);
    setConfirmationChecks([]);
    setHasEditedReview(false);
    setReviewedRowIds([]);
    setUnresolvedRowIds([]);
    setActiveReviewRowIndex(0);
  }, [selectedIssue?.id, defaultManualAccountKey]);

  const displayedTransactions = transactions
    .filter((transaction) => {
      if (!searchTerm) return true;
      const query = searchTerm.toLowerCase();
      return (
        transaction.counterpartyName.toLowerCase().includes(query) ||
        transaction.summary.toLowerCase().includes(query) ||
        String(transaction.amount).includes(query) ||
        transaction.transactionDate.includes(query) ||
        transaction.bankName.toLowerCase().includes(query) ||
        transaction.accountNumber.includes(query)
      );
    })
    .filter(
      (transaction) =>
        transactionFilter === "ALL" ||
        transactionReviewState(
          transaction,
          issuesByTransaction.get(transaction.id) || [],
        ) === transactionFilter,
    );
  const statusCounts = transactions.reduce(
    (counts, transaction) => {
      const status = transactionReviewState(
        transaction,
        issuesByTransaction.get(transaction.id) || [],
      );
      counts[status] += 1;
      return counts;
    },
    { PENDING: 0, VERIFIED: 0, CORRECTED: 0, AUTO: 0 },
  );

  const openTransactionReview = (
    transaction: StandardTransaction,
    issue?: EvidenceReviewIssue,
  ) => {
    const account = accounts.find((item) =>
      transactionBelongsToAccount(transaction, item),
    );
    if (account) setSelectedAccNum(accountIdentityKey(account));
    setSelectedTransactionId(transaction.id);
    if (issue) setSelectedIssueId(issue.id);
    else setSelectedIssueId("");
    setIsReviewOpen(true);
  };

  const openIssueReview = (
    account: BankAccount,
    issue: EvidenceReviewIssue,
  ) => {
    setSelectedAccNum(accountIdentityKey(account));
    setSelectedIssueId(issue.id);
    setSelectedTransactionId(issue.transactionIds[0] || "");
    setIsReviewOpen(true);
  };

  const navigatePendingIssue = (direction: 1 | -1) => {
    if (!reviewQueueGroups.length) return;
    const currentIndex = Math.max(
      0,
      reviewQueueGroups.findIndex((group) =>
        group.issues.some((issue) => issue.id === selectedIssueId),
      ),
    );
    for (let offset = 1; offset <= reviewQueueGroups.length; offset += 1) {
      const index =
        (currentIndex + direction * offset + reviewQueueGroups.length) %
        reviewQueueGroups.length;
      const group = reviewQueueGroups[index];
      const pendingIssue = group.issues.find(
        isOutstandingRequired,
      );
      if (pendingIssue) {
        openIssueReview(group.account, pendingIssue);
        return;
      }
    }
  };

  const advanceAfterResolution = (resolvedIssueId: string) => {
    const currentIndex = Math.max(
      0,
      reviewQueueGroups.findIndex((group) =>
        group.issues.some((issue) => issue.id === resolvedIssueId),
      ),
    );
    for (let offset = 1; offset <= reviewQueueGroups.length; offset += 1) {
      const group =
        reviewQueueGroups[(currentIndex + offset) % reviewQueueGroups.length];
      const pendingIssue = group.issues.find(
        isOutstandingRequired,
      );
      if (
        pendingIssue &&
        !group.issues.some((issue) => issue.id === resolvedIssueId)
      ) {
        openIssueReview(group.account, pendingIssue);
        return;
      }
    }
    setIsReviewOpen(false);
  };

  const commitTransactions = (updated: StandardTransaction[]) => {
    onTransactionsUpdated(updated);
    if (!selectedAccount) return;
    onAccountsUpdated(
      accounts.map(account => {
        if (reviewDocumentKey(account) !== reviewDocumentKey(selectedAccount)) return account;
        const ownIds = new Set(buildEvidenceReviewIssues(account, transactions).map(issue => issue.id));
        return summarizeAccount({ ...account,
          reviewIssues: preserveReviewIssues(account.reviewIssues || [], selectedIssueGroup.filter(issue => ownIds.has(issue.id)))
        }, updated);
      }),
    );
  };

  const saveIssueStatus = (
    issue: EvidenceReviewIssue,
    status: ReviewIssueStatus,
    defaultNote = "",
    transactionSource = transactions,
  ) => {
    const groupIssues = issues.filter((item) => sameReviewPage(item, issue));
    const groupIssueIds = new Set(groupIssues.map((item) => item.id));
    const reviewedAt = new Date().toISOString();
    const updatedIssues = issues.map((item) => {
      const confirmedRows = isTransactionLevelIssue(item) && item.transactionIds.length > 0 && item.transactionIds.every(id => {
        const row = transactionSource.find(row => row.id === id);
        return row?.reviewedBy === '律师人工核对' && Boolean(row.reviewedAt)
          && (row.reviewStatus === 'VERIFIED' || row.reviewStatus === 'CORRECTED')
          && !row.dataQualityIssues?.length && (!row.candidateReview || row.candidateReview.status === 'CONFIRMED');
      });
      return groupIssueIds.has(item.id)
        ? {
            ...item,
            status: status === 'UNRESOLVED' && confirmedRows ? 'CONFIRMED' as const : status,
            resolutionNote: resolutionNote.trim() || defaultNote,
            reviewedAt,
          }
        : item;
    });
    onAccountsUpdated(accounts.map(account => {
      if (!selectedAccount || reviewDocumentKey(account) !== reviewDocumentKey(selectedAccount)) return account;
      const ownIssues = buildEvidenceReviewIssues(account, transactions);
      const updatedById = new Map(updatedIssues.map(item => [item.id, item]));
      return summarizeAccount({ ...account, reviewIssues: ownIssues.map(item => updatedById.get(item.id) || item) }, transactionSource);
    }));
    const groupTransactionIds = new Set(
      groupIssues
        .filter(isTransactionLevelIssue)
        .flatMap((item) => item.transactionIds),
    );
    if (groupTransactionIds.size) {
      onTransactionsUpdated(
        transactionSource.map((transaction) => {
          if (!groupTransactionIds.has(transaction.id)) return transaction;
          const evidenceDecision = status === "UNRESOLVED" ? "UNRESOLVED" as const : "CONFIRMED" as const;
          const fieldEvidence = transaction.fieldEvidence && Object.fromEntries(
            Object.entries(transaction.fieldEvidence).map(([field, evidence]) => {
              if (!evidence || (status === "UNRESOLVED" && evidence.decision === "CONFIRMED")) return [field, evidence];
              return [field, {
                ...evidence,
                decision: evidenceDecision,
                reviewedBy: status === "UNRESOLVED" ? evidence.reviewedBy : "律师人工核对",
                reviewedAt
              }];
            })
          ) as StandardTransaction['fieldEvidence'];
          const hasUnresolvedEvidence = Object.values(fieldEvidence || {}).some(evidence => evidence?.decision === "UNRESOLVED");
          return {
            ...transaction,
            candidateReview: transaction.candidateReview ? { ...transaction.candidateReview,
              status: status === 'UNRESOLVED' && transaction.candidateReview.status !== 'CONFIRMED'
                ? 'UNRESOLVED' as const : 'CONFIRMED' as const, reviewedAt
            } : undefined,
            reviewStatus:
              status === "CORRECTED"
                ? "CORRECTED" as const
                : status === "CONFIRMED"
                  ? "VERIFIED" as const
                  : hasUnresolvedEvidence ? "PENDING" as const : transaction.reviewStatus,
            reviewedBy: status === "UNRESOLVED" ? transaction.reviewedBy : "律师人工核对",
            reviewedAt,
            fieldEvidence
          };
        }),
      );
    }
  };

  const resolveIssueAndAdvance = (
    issue: EvidenceReviewIssue,
    status: "CONFIRMED" | "CORRECTED" | "UNRESOLVED",
    note: string,
  ) => {
    saveIssueStatus(issue, status, note);
    advanceAfterResolution(issue.id);
  };

  const removeSelectedTransactions = () => {
    if (!selectedIssue || selectedRemovalIds.length === 0) return;
    if (
      !window.confirm(
        `确定从结构化明细中删除选中的 ${selectedRemovalIds.length} 笔记录吗？原始PDF不会被修改。`,
      )
    )
      return;
    const updated = transactions.filter(
      (transaction) => !selectedRemovalIds.includes(transaction.id),
    );
    commitTransactions(updated);
    // Deleting a duplicate does not confirm the remaining page's fields.
    setHasEditedReview(true);
    setSelectedRemovalIds([]);
  };

  const handleCellEdit = (
    transactionId: string,
    field: keyof StandardTransaction,
    value: any,
  ) => {
    const updated = transactions.map((transaction) => {
      if (transaction.id !== transactionId) return transaction;
      const reviewedAt = new Date().toISOString();
      const next = {
        ...transaction,
        [field]: value,
        reviewStatus: "CORRECTED" as const,
        reviewedBy: "律师人工核对",
        reviewedAt,
      };
      if (isEvidenceField(field)) {
        const existing = transaction.fieldEvidence?.[field];
        next.fieldEvidence = {
          ...(transaction.fieldEvidence || {}),
          [field]: {
            originalValue: existing?.originalValue ?? evidencePrimitive(transaction[field]),
            currentValue: evidencePrimitive(value),
            confidence: 1,
            origin: "LAWYER_REVIEW" as const,
            decision: "CONFIRMED" as const,
            reason: "律师对照原件修改",
            reviewedBy: "律师人工核对",
            reviewedAt,
          },
        };
      }
      if (field === "transactionTime")
        next.transactionDate = String(value).slice(0, 10);
      const qualityIssues = new Set(next.dataQualityIssues || []);
      if ((field === "transactionTime" || field === "transactionDate") && /^20\d{2}-\d{2}-\d{2}/.test(String(value)))
        qualityIssues.delete("INVALID_DATE");
      if (field === "amount" && Number(value) > 0)
        qualityIssues.delete("INVALID_AMOUNT");
      if (field === "direction" && value !== "UNKNOWN")
        qualityIssues.delete("UNKNOWN_DIRECTION");
      next.dataQualityIssues = [...qualityIssues];
      return next;
    });
    commitTransactions(updated);
    if (selectedIssue && affectedTransactionIds.includes(transactionId)) {
      setHasEditedReview(true);
      setReviewedRowIds(current => current.filter(id => id !== transactionId));
      setUnresolvedRowIds(current => current.filter(id => id !== transactionId));
    }
  };

  const handleRowDecision = (transaction: StandardTransaction, decision: RowReviewDecision) => {
    const rowIssues = selectedIssueGroup.filter(issue => issue.transactionIds.includes(transaction.id));
    const fields = reviewFieldsForTransaction(transaction, rowIssues);
    const updated = transactions.map(item => item.id === transaction.id
      ? applyRowReviewDecision(item, fields, decision)
      : item);
    commitTransactions(updated);
    if (decision === "UNRESOLVED") {
      setUnresolvedRowIds(current => current.includes(transaction.id) ? current : [...current, transaction.id]);
      setReviewedRowIds(current => current.filter(id => id !== transaction.id));
    } else {
      setReviewedRowIds(current => current.includes(transaction.id) ? current : [...current, transaction.id]);
      setUnresolvedRowIds(current => current.filter(id => id !== transaction.id));
      if (decision === "USE_ORIGINAL") setHasEditedReview(true);
    }
    const currentIndex = fieldIssueTransactions.findIndex(item => item.id === transaction.id);
    if (currentIndex >= 0 && currentIndex < fieldIssueTransactions.length - 1) {
      setActiveReviewRowIndex(currentIndex + 1);
    }
  };

  const openFirstBalanceCheck = () => {
    const priorityIssue = issues.find(issue => issue.category === "BALANCE_BREAK" && isOutstandingRequired(issue))
      || issues.find(isOutstandingRequired);
    if (priorityIssue && selectedAccount) {
      openIssueReview(selectedAccount, priorityIssue);
      return;
    }
    const suspiciousId = auditReport?.suspiciousRows[0]?.transactionId;
    const suspiciousTransaction = transactions.find(transaction => transaction.id === suspiciousId);
    if (suspiciousTransaction) {
      openTransactionReview(suspiciousTransaction);
      return;
    }
    setTransactionFilter("ALL");
    document.getElementById("transaction-detail-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const addMissingTransaction = () => {
    if (!selectedAccount || !selectedIssue) return;
    const targetAccount = accounts.find(account => accountIdentityKey(account) === draft.accountKey)
      || (!isDocumentReviewAccount(selectedAccount) ? selectedAccount : undefined);
    if (!targetAccount || isDocumentReviewAccount(targetAccount)) {
      window.alert("请先选择这笔流水所属的真实账户。若账户尚未识别，请返回上传页重新识别该文件。");
      return;
    }
    const amount = Number(draft.amount);
    if (!draft.transactionTime || !Number.isFinite(amount) || amount <= 0) {
      window.alert("请至少填写有效的交易日期和金额。");
      return;
    }
    const page = selectedIssue.pageNumber || 1;
    const pageTransactions = transactions.filter(
      (transaction) =>
        transactionBelongsToAccount(transaction, targetAccount) &&
        transaction.rawPageNumber === page,
    );
    const added: StandardTransaction = {
      id: `TX_MANUAL_${Date.now()}`,
      accountNumber: targetAccount.accountNumber,
      accountName: targetAccount.accountName,
      bankName: targetAccount.bankName,
      transactionTime: draft.transactionTime,
      transactionDate: draft.transactionTime.slice(0, 10),
      direction: draft.direction,
      amount,
      balance: Number(draft.balance) || 0,
      balanceAvailable: draft.balance !== "",
      counterpartyName: draft.counterpartyName,
      summary: draft.summary,
      rawSourceFile: targetAccount.fileName,
      rawPageNumber: page,
      rawRowIndex:
        Math.max(0, ...pageTransactions.map((item) => item.rawRowIndex || 0)) +
        1,
      extractionMethod: "MANUAL",
      extractionConfidence: 1,
      reviewStatus: "CORRECTED",
      reviewedBy: "律师人工核对",
      reviewedAt: new Date().toISOString(),
      lawyerNote: "律师根据原始流水补录",
      sourceDocumentId: targetAccount.sourceDocumentId,
      sourceContentHash: targetAccount.sourceContentHash,
      extractionRunId: targetAccount.extractionRunId,
    };
    added.sourceObservationId = added.id;
    added.fieldEvidence = createFieldEvidenceSnapshot(added, "LAWYER_REVIEW", "CONFIRMED");
    const updated = [...transactions, added];
    onTransactionsUpdated(updated);
    onAccountsUpdated(accounts.map(account => {
      if (accountIdentityKey(account) === accountIdentityKey(targetAccount)) {
        return summarizeAccount(account, updated);
      }
      if (accountIdentityKey(account) === accountIdentityKey(selectedAccount)) {
        return { ...account, reviewIssues: preserveReviewIssues(account.reviewIssues || [], selectedIssueGroup) };
      }
      return account;
    }));
    setHasEditedReview(true);
    setShowAddForm(false);
    setDraft(emptyDraft(accountIdentityKey(targetAccount)));
  };

  const continueToNext = () => {
    if (blockingRecognitionIssues.length) {
      const firstBlocking = blockingRecognitionIssues[0];
      const group = reviewQueueGroups.find(item => item.issues.some(issue => issue.id === firstBlocking.id));
      window.alert(`还有 ${blockingRecognitionIssues.length} 个页面识别任务没有完成。请先返回上传页重新识别，或对照原件补录并完成这些页面后再进入资金分析。`);
      if (group) openIssueReview(group.account, firstBlocking);
      return;
    }
    const outstanding: string[] = [];
    if (allRequiredOutstanding.length > 0) outstanding.push(`${pendingReviewGroups.length} 页尚未人工核对`);
    if (unbalancedAccounts.length > 0) outstanding.push(`${unbalancedAccounts.length} 个账户尚未平账`);
    if (outstanding.length && !window.confirm(
      `当前仍有${outstanding.join('，')}。继续后，这些事项会作为数据限制保留在分析和导出报告中。是否继续？`,
    )) return;
    onNext();
  };

  const copyAllDiagnostics = async () => {
    try {
      await copyText(formatRecognitionDiagnostics(accounts, transactions));
      setCopyState("COPIED");
    } catch {
      setCopyState("ERROR");
    }
    window.setTimeout(() => setCopyState("IDLE"), 2500);
  };

  return (
    <div className="max-w-[1500px] mx-auto py-8 px-4 sm:px-6 space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
              Step 2 / 6 原件核对
            </span>
            <h2 className="text-xl font-bold text-slate-900 mt-2">
              银行流水数据准确性复核
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              逐项对照原始文件，确认页数、交易笔数、日期、方向、金额、余额、对手方及摘要。这里只确认“是否读取正确”，不判断交易原因是否真实。
            </p>
          </div>
          <button
            type="button"
            onClick={copyAllDiagnostics}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 flex-shrink-0"
          >
            {copyState === "COPIED" ? <ClipboardCheck className="w-4 h-4 text-emerald-600" /> : <Clipboard className="w-4 h-4" />}
            {copyState === "COPIED" ? "已复制全部异常" : copyState === "ERROR" ? "复制失败，请重试" : "复制全部识别异常"}
          </button>
        </div>
        <div className="flex items-center gap-2 mt-5 overflow-x-auto pb-1">
          {accounts.map((account) => {
            const isDocumentReview = isDocumentReviewAccount(account);
            const pending = buildReviewGroups([account], transactions).filter(
              (group) =>
                group.issues.some(isOutstandingRequired),
            ).length;
            const identity = accountIdentityKey(account);
            const accountAudit = accountAuditMap.get(identity);
            const isUnbalanced = Boolean(accountAudit?.isAuditable && !accountAudit.isBalanced);
            const hasUnknownAccount = /待核对账号|待归属|未知账号/.test(account.accountNumber);
            const badgeLabel = isDocumentReview
              ? '识别未完成'
              : pending
              ? `待核对 ${pending} 页`
              : hasUnknownAccount
                ? '账号待核对'
                : isUnbalanced
                  ? '未平账'
                  : accountReviewLabel(account, transactions);
            const badgeClass = pending
              ? 'bg-amber-400 text-amber-950'
              : hasUnknownAccount || isUnbalanced
                ? 'bg-rose-400 text-rose-950'
                : 'bg-emerald-400 text-emerald-950';
            return (
              <button
                key={identity}
                onClick={() => {
                  setSelectedAccNum(identity);
                  setSelectedIssueId("");
                  setSelectedTransactionId("");
                }}
                className={`px-4 py-2 rounded-xl text-xs font-medium flex items-center gap-2 flex-shrink-0 ${selectedAccNum === identity ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                <span>
                  {isDocumentReview
                    ? `${account.fileName} · 未识别页`
                    : `${account.bankName}（${account.accountNumber.slice(-4)}）`}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] ${badgeClass}`}
                >
                  {badgeLabel}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {pageLevelIssueGroups.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-bold text-sm text-amber-950 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                待核对页面（{pageLevelIssueGroups.length} 页）
              </div>
              <p className="text-[11px] text-amber-800 mt-1">
                同一页发现的多个问题已合并；打开一次即可在同一弹窗内全部核对。
              </p>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto mt-3 pb-1">
            {pageLevelIssueGroups.map((group) => {
              const requiredIssueCount = new Set(group.issues.filter(issue => issue.severity === "REQUIRED").map(issue => issue.category)).size;
              const advisoryIssueCount = group.issues.filter(issue => issue.severity === "ADVISORY").length;
              const pendingIssue =
                group.issues.find(
                  (issue) =>
                    issue.status === "PENDING" || issue.status === "UNRESOLVED",
                ) || group.issues[0];
              const state = reviewGroupStatus(group);
              return (
                <button
                  key={group.key}
                  onClick={() => openIssueReview(group.account, pendingIssue)}
                  className="min-w-64 max-w-sm text-left bg-white border border-amber-200 rounded-xl p-3 hover:border-amber-400"
                >
                  <div className="flex justify-between gap-2">
                    <span className="text-[10px] font-semibold text-amber-800">
                      {group.account.fileName} · 第{group.pageNumber || "?"}页
                    </span>
                    <span className={`text-[10px] ${statusColor(state)}`}>
                      {statusLabel(state)}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-slate-800 mt-1">
                    本页需处理 {requiredIssueCount} 类问题
                    {advisoryIssueCount > 0 ? ` · ${advisoryIssueCount} 项参考提示` : ""}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                    {[...new Set(group.issues.map(plainIssueName))].join("；")}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {documentAdvisoryGroups.length > 0 && (
        <details className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">
            文件整体提示（不计入必须核对项）
          </summary>
          <div className="mt-2 space-y-2 text-[11px] text-slate-600">
            {documentAdvisoryGroups.flatMap(group => group.issues).map(issue => (
              <p key={issue.id}>{issue.description}</p>
            ))}
          </div>
        </details>
      )}

      {selectedAccount && auditReport && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <AuditCard
              title="账户平账检查"
              value={
                !auditReport.isAuditable
                  ? auditReport.unavailableReason === "CREDIT_CARD_STATEMENT"
                    ? "信用卡账单，不适用储蓄卡逐笔平账"
                    : "缺少余额，无法计算"
                  : auditReport.isBalanced
                    ? "已平账"
                    : `未平账 · 相差 ¥${auditReport.difference.toFixed(2)}`
              }
              alert={auditReport.isAuditable && !auditReport.isBalanced}
            />
            <AuditCard
              title="账户收入总计"
              value={`¥ ${auditReport.totalIncome.toLocaleString()}`}
            />
            <AuditCard
              title="账户支出总计"
              value={`¥ ${auditReport.totalExpense.toLocaleString()}`}
            />
            <AuditCard
              title="流水时间跨度"
              value={`${selectedAccount.startDate || "待核对"} ～ ${selectedAccount.endDate || "待核对"}`}
            />
          </div>
          {auditReport.isAuditable && !auditReport.isBalanced && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-900 space-y-3">
              <div>
                <div className="font-semibold text-sm">该账户没有平上，需要查出差额来源</div>
                <p className="mt-1 leading-relaxed text-rose-800">
                  “相差 ¥{auditReport.difference.toFixed(2)}”不是指某一笔交易，而是当前提取结果计算出的期末余额与原件期末余额不一致。
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-2 rounded-xl border border-rose-200 bg-white/70 p-3 text-center">
                <BalanceFormulaItem label="原件期初余额" value={selectedAccount.startBalance} />
                <span className="text-rose-400">＋</span>
                <BalanceFormulaItem label="已提取收入" value={auditReport.totalIncome} />
                <span className="text-rose-400">－</span>
                <BalanceFormulaItem label="已提取支出" value={auditReport.totalExpense} />
                <span className="text-rose-400">＝</span>
                <BalanceFormulaItem label="系统算出的期末" value={auditReport.calculatedEndBalance} />
              </div>
              <div className="rounded-xl border border-rose-200 bg-white/70 p-3">
                <div className="font-semibold">原件期末余额：¥{auditReport.statedEndBalance.toLocaleString()}</div>
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] text-slate-700">
                  <div>
                    <div className="font-semibold text-slate-800">通常可能是</div>
                    <ul className="list-disc pl-4 mt-1 space-y-1">
                      <li>漏识别或重复识别了一笔流水</li>
                      <li>某笔金额、收支方向或交易后余额读错</li>
                      <li>期初／期末余额读取错误，或不同账号混在一起</li>
                    </ul>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-800">建议按这个顺序确认</div>
                    <ol className="list-decimal pl-4 mt-1 space-y-1">
                      <li>核对原件首页期初余额和末页期末余额</li>
                      <li>处理系统标出的待核对流水和余额断点</li>
                      <li>逐页清点原件行数，确认没有漏行、重复行或串账号</li>
                    </ol>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={openFirstBalanceCheck}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-700 px-3 py-2 text-[11px] font-semibold text-white hover:bg-rose-800"
              >
                <Search className="w-3.5 h-3.5" />
                {issues.some(isOutstandingRequired) || auditReport.suspiciousRows.length
                  ? "从最需要核对的流水开始"
                  : "查看全部流水并逐页核对"}
              </button>
            </div>
          )}
        </div>
      )}

      <div id="transaction-detail-table" className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-bold">
                全部账户交易明细（{transactions.length} 笔）
              </h3>
              <p className="text-[11px] text-slate-500 mt-1">
                正常记录与问题记录统一列示；点击任意一行可展开核对原因。
              </p>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="搜索账户、对手方、金额、附言"
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg border w-64"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {(
              [
                ["ALL", "全部", transactions.length],
                ["PENDING", "待核对", statusCounts.PENDING],
                ["VERIFIED", "已确认", statusCounts.VERIFIED],
                ["CORRECTED", "已修正", statusCounts.CORRECTED],
                ["AUTO", "系统校验通过", statusCounts.AUTO],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                onClick={() => setTransactionFilter(value)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-medium border ${transactionFilter === value ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600"}`}
              >
                {label} {count}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4 text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <i className="w-2.5 h-2.5 rounded-sm bg-rose-200" />
              待核对
            </span>
            <span className="flex items-center gap-1">
              <i className="w-2.5 h-2.5 rounded-sm bg-blue-200" />
              已修正
            </span>
            <span className="flex items-center gap-1">
              <i className="w-2.5 h-2.5 rounded-sm bg-emerald-200" />
              已确认
            </span>
            <span className="flex items-center gap-1">
              <i className="w-2.5 h-2.5 rounded-sm bg-white border" />
              系统校验通过
            </span>
          </div>
        </div>
        <div className="overflow-auto max-h-[560px]">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr>
                <th className="p-3">序号</th>
                <th className="p-3">账户</th>
                <th className="p-3">交易时间</th>
                <th className="p-3">方向</th>
                <th className="p-3">金额</th>
                <th className="p-3">余额</th>
                <th className="p-3">对手方</th>
                <th className="p-3">摘要</th>
                <th className="p-3">原件位置</th>
                <th className="p-3">核对状态</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {displayedTransactions.map((transaction, index) => {
                const transactionIssues =
                  issuesByTransaction.get(transaction.id) || [];
                const state = transactionReviewState(
                  transaction,
                  transactionIssues,
                );
                const expanded = expandedTransactionId === transaction.id;
                return (
                  <React.Fragment key={transaction.id}>
                    <tr
                      onClick={() =>
                        setExpandedTransactionId(expanded ? "" : transaction.id)
                      }
                      className={`cursor-pointer transition ${rowBackground(state)}`}
                    >
                      <td
                        className={`p-3 text-slate-400 border-l-4 ${rowBorder(state)}`}
                      >
                        {index + 1}
                      </td>
                      <td className="p-3">
                        <div className="font-medium">
                          {transaction.bankName}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          尾号 {transaction.accountNumber.slice(-4)}
                        </div>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {transaction.transactionTime || transaction.transactionDate || "待核对"}
                      </td>
                      <td
                        className={`p-3 font-semibold ${transaction.direction === "IN" ? "text-emerald-700" : transaction.direction === "OUT" ? "text-rose-700" : "text-amber-700"}`}
                      >
                        {transaction.direction === "IN" ? "收入" : transaction.direction === "OUT" ? "支出" : "待核对"}
                      </td>
                      <td className="p-3 font-mono">
                        ¥{transaction.amount.toLocaleString()}
                      </td>
                      <td className="p-3 font-mono">
                        {transaction.balanceAvailable === false
                          ? "—"
                          : `¥${transaction.balance.toLocaleString()}`}
                      </td>
                      <td className="p-3">{transaction.counterpartyName}</td>
                      <td className="p-3 max-w-44 truncate">
                        {transaction.summary}
                      </td>
                      <td className="p-3 text-blue-600">
                        <span className="inline-flex items-center gap-1">
                          <Eye className="w-3.5 h-3.5" />第
                          {transaction.rawPageNumber || "?"}页
                        </span>
                      </td>
                      <td className="p-3 text-[11px] font-medium">
                        {transaction.excludedFromAnalysis
                          ? "重复观察 · 分析只计一次"
                          : transactionStateLabel(state)}
                      </td>
                      <td className="p-3">
                        {expanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={11} className="p-0">
                          <div className="px-6 py-4 bg-slate-50 border-l-4 border-blue-400 flex items-start justify-between gap-4">
                            <div className="space-y-2">
                              <div className="font-semibold text-xs text-slate-800">
                                {transaction.excludedFromAnalysis
                                  ? `该行与 ${transaction.duplicateOfTransactionId || "另一条记录"} 属于同一笔交易`
                                  : transactionIssues.length
                                  ? `该笔涉及 ${transactionIssues.length} 项核对问题`
                                  : "自动检查未发现明确问题"}
                              </div>
                              {transaction.excludedFromAnalysis && (
                                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-800">
                                  原始行仍完整保留并可查看，但账户汇总、平账、资金流向和风险分析只计算代表记录一次。
                                </div>
                              )}
                              {transactionIssues.length ? (
                                <div className="space-y-2">
                                  {transactionIssues.map((issue) => (
                                    <div
                                      key={issue.id}
                                      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-slate-700"
                                    >
                                      <div className="font-semibold text-amber-900">{plainIssueName(issue)}</div>
                                      <div className="mt-1">需要确认：{reviewIssueExplanation(issue, [transaction]).confirm.join("、")}。</div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-[11px] text-slate-500">
                                  仍可抽查原始页面；系统校验通过只表示字段与账面关系未发现明显异常，不代表已经完成人工核对，也不证明交易用途或法律事实。
                                </p>
                              )}
                              {transaction.rawText && (
                                <p className="text-[11px] text-slate-500">
                                  识别原文：{transaction.rawText}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                openTransactionReview(
                                  transaction,
                                  transactionIssues.find(
                                    (issue) =>
                                      issue.status === "PENDING" ||
                                      issue.status === "UNRESOLVED",
                                  ) || transactionIssues[0],
                                );
                              }}
                              className="flex-shrink-0 px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-medium"
                            >
                              查看原件并处理
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {!displayedTransactions.length && (
            <div className="py-12 text-center text-sm text-slate-500">
              当前筛选条件下没有交易记录。
            </div>
          )}
        </div>
        <div className="p-4 bg-slate-50 border-t flex justify-between items-center">
          <button
            onClick={onPrev}
            className="flex items-center gap-1.5 px-4 py-2 text-slate-600 text-xs"
          >
            <ArrowLeft className="w-4 h-4" />
            返回上传
          </button>
          <div className="flex items-center gap-3">
            {(pendingReviewGroups.length > 0 || unbalancedAccounts.length > 0) && (
              <span className="text-xs text-amber-700 flex items-center gap-1">
                <CircleHelp className="w-4 h-4" />
                {pendingReviewGroups.length > 0 ? `${pendingReviewGroups.length} 页待核对` : ''}
                {pendingReviewGroups.length > 0 && unbalancedAccounts.length > 0 ? '，' : ''}
                {unbalancedAccounts.length > 0 ? `${unbalancedAccounts.length} 个账户未平账` : ''}
              </span>
            )}
            <button
              onClick={continueToNext}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-white text-sm font-medium ${blockingRecognitionIssues.length ? "bg-amber-600 hover:bg-amber-700" : "bg-blue-600"}`}
            >
              <Check className="w-4 h-4" />
              {blockingRecognitionIssues.length
                ? `请先处理 ${blockingRecognitionIssues.length} 个未识别页面`
                : pendingReviewGroups.length || unbalancedAccounts.length
                ? "保留未处理事项并继续"
                : "完成核对，进入下一步"}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {isReviewOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm p-3 sm:p-6 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[1380px] max-h-[94vh] overflow-hidden">
            <div className="h-14 px-5 border-b flex items-center justify-between gap-3">
              <div>
                <div className="font-bold text-sm text-slate-900">
                  原始文件核对
                </div>
                <div className="text-[11px] text-slate-500">
                  {selectedAccount?.fileName} · 第{" "}
                  {selectedIssue?.pageNumber ||
                    selectedTransaction?.rawPageNumber ||
                    1}{" "}
                  页
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selectedIssue && (
                  <>
                    <span className="text-[11px] text-slate-500">
                      还有 {pendingReviewCount} 页待核对
                    </span>
                    <button
                      onClick={() => navigatePendingIssue(-1)}
                      className="px-3 py-1.5 rounded-lg border text-xs text-slate-600 hover:bg-slate-50"
                    >
                      上一页
                    </button>
                    <button
                      onClick={() => navigatePendingIssue(1)}
                      className="px-3 py-1.5 rounded-lg border text-xs text-slate-600 hover:bg-slate-50"
                    >
                      下一待核对页
                    </button>
                  </>
                )}
                <button
                  onClick={() => setIsReviewOpen(false)}
                  className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(520px,1fr)_410px] max-h-[calc(94vh-56px)] overflow-hidden">
              <section className="relative min-w-0">
                {isSourceLoading ? (
                  <div className="h-[620px] flex items-center justify-center text-sm text-slate-500">
                    正在打开原始文件…
                  </div>
                ) : (
                  <PdfEvidencePage
                    file={sourceFile}
                    pageNumber={
                      sourceFocusTransaction?.rawPageNumber ||
                      selectedIssue?.pageNumber ||
                      selectedTransaction?.rawPageNumber ||
                      affectedTransactions[0]?.rawPageNumber ||
                      1
                    }
                    sourceRegion={sourceFocusRegion}
                    rowLabel={sourceFocusTransaction?.rawRowIndex ? `第 ${sourceFocusTransaction.rawRowIndex} 行` : undefined}
                  />
                )}
              </section>
              <section className="border-l border-slate-200 p-4 overflow-y-auto max-h-[calc(94vh-56px)]">
                {!selectedIssue ? (
                  selectedTransaction ? (
                    <NormalTransactionPanel
                      transaction={selectedTransaction}
                      onEdit={handleCellEdit}
                    />
                  ) : (
                    <div className="text-center text-sm text-slate-500 py-16">
                      请选择一笔交易或页面问题。
                    </div>
                  )
                ) : (
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="w-4 h-4 text-amber-600" />
                        <h3 className="font-bold text-sm text-slate-900">
                          本页有 {new Set(selectedIssueGroup.map(issue => issue.category)).size} 类问题，需逐行确认 {fieldIssueTransactions.length} 笔流水
                        </h3>
                      </div>
                      <div className="mt-2 space-y-2">
                        {pageReviewNotices.map((issue, index) => {
                          const issueTransactions = affectedTransactions.filter(transaction => issue.transactionIds.includes(transaction.id));
                          const explanation = reviewIssueExplanation(issue, issueTransactions);
                          return (
                            <div key={issue.id} className="border border-slate-200 rounded-xl p-3 space-y-2">
                              <div className="text-xs font-semibold text-slate-900">
                                {index + 1}. {plainIssueName(issue)}
                              </div>
                              <ReviewExplanationRow label="系统发现" text={explanation.detected} tone="rose" />
                              <ReviewExplanationRow label="可能原因" text={explanation.possible.join("；")} tone="amber" />
                              <ReviewExplanationRow label="请确认" text={explanation.confirm.join("；")} tone="blue" />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {selectedCountComparison && (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900">
                        <div className="font-semibold">
                          这两个数字都不是“已核实数量”
                        </div>
                        <p className="mt-1 leading-relaxed">
                          {selectedCountComparison.summaryCount}{" "}
                          笔是一次页面计数，
                          {selectedCountComparison.detailCount}{" "}
                          笔是逐笔提取结果。请直接清点左侧原始页面，以原件实际行数为准。
                        </p>
                      </div>
                    )}
                    <div className="bg-blue-50 border border-blue-100 rounded-xl p-3">
                      <div className="text-xs font-semibold text-blue-900">处理方法</div>
                      <ol className="list-decimal pl-4 mt-2 space-y-1 text-[11px] text-blue-800">
                        {[
                          ...new Set(
                            selectedIssueGroup.flatMap(
                              (issue) => issue.instructions,
                            ),
                          ),
                        ].map((instruction, index) => (
                          <li key={index}>{instruction}</li>
                        ))}
                      </ol>
                    </div>
                    {!selectedIssueHasLocation ? (
                      <>
                        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs text-rose-800">
                          <div className="font-semibold">
                            暂时无法列出对应明细
                          </div>
                          <p className="mt-1 leading-relaxed">
                            这条历史核对记录缺少原件页码，无法安全判断应展示哪一页的交易。请返回上传步骤重新选择原始
                            PDF，系统会重新建立逐页定位后再核对。
                          </p>
                        </div>
                        <button
                          onClick={() =>
                            resolveIssueAndAdvance(
                              selectedIssue,
                              "UNRESOLVED",
                              "历史核对记录缺少原件页码，暂时无法定位",
                            )
                          }
                          className="w-full border border-amber-300 text-amber-800 rounded-xl py-2 text-xs font-medium"
                        >
                          暂记为无法定位，进入下一项
                        </button>
                      </>
                    ) : (
                      <>
                        {fieldIssueTransactions.length > 0 ? (
                          <div className="space-y-2">
                            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-[11px] text-blue-900">
                              <div className="flex items-center justify-between gap-3">
                                <div className="font-semibold">逐笔核对 · 第 {Math.min(activeReviewRowIndex + 1, fieldIssueTransactions.length)} / {fieldIssueTransactions.length} 笔</div>
                                <div className="text-blue-700">已确认 {reviewedRowIds.filter(id => fieldIssueTransactionIds.has(id)).length} · 无法确认 {unresolvedRowIds.filter(id => fieldIssueTransactionIds.has(id)).length}</div>
                              </div>
                              <div className="mt-1">右侧每次只显示一笔问题流水。对照左侧原件对应行，只处理标出的字段。</div>
                            </div>
                            {activeReviewTransaction && (
                              <TransactionReviewTask
                                key={activeReviewTransaction.id}
                                taskNumber={activeReviewRowIndex + 1}
                                transaction={activeReviewTransaction}
                                issues={selectedIssueGroup.filter(issue => issue.transactionIds.includes(activeReviewTransaction.id))}
                                onEdit={handleCellEdit}
                                reviewed={reviewedRowIds.includes(activeReviewTransaction.id)}
                                unresolved={unresolvedRowIds.includes(activeReviewTransaction.id)}
                                onDecision={(decision) => handleRowDecision(activeReviewTransaction, decision)}
                              />
                            )}
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={() => setActiveReviewRowIndex(index => Math.max(0, index - 1))}
                                disabled={activeReviewRowIndex <= 0}
                                className="rounded-lg border border-slate-300 py-2 text-[11px] font-medium text-slate-600 disabled:opacity-40"
                              >
                                上一笔
                              </button>
                              <button
                                type="button"
                                onClick={() => setActiveReviewRowIndex(index => Math.min(fieldIssueTransactions.length - 1, index + 1))}
                                disabled={activeReviewRowIndex >= fieldIssueTransactions.length - 1}
                                className="rounded-lg border border-slate-300 py-2 text-[11px] font-medium text-slate-600 disabled:opacity-40"
                              >
                                下一笔
                              </button>
                            </div>
                          </div>
                        ) : (
                          <PageTransactionSelector
                            transactions={affectedTransactions}
                            selectedIds={selectedRemovalIds}
                            onToggle={(id) =>
                              setSelectedRemovalIds((current) =>
                                current.includes(id)
                                  ? current.filter((item) => item !== id)
                                  : [...current, id],
                              )
                            }
                          />
                        )}
                        {selectedRemovalIds.length > 0 && (
                          <button
                            onClick={removeSelectedTransactions}
                            className="w-full border border-rose-300 bg-rose-50 text-rose-700 rounded-xl py-2 text-xs font-medium"
                          >
                            删除选中的 {selectedRemovalIds.length} 笔多余记录
                          </button>
                        )}
                        <button
                          onClick={() => setShowAddForm((value) => !value)}
                          className="w-full flex items-center justify-center gap-1.5 border border-blue-200 text-blue-700 rounded-xl py-2 text-xs font-medium hover:bg-blue-50"
                        >
                          <FilePlus2 className="w-4 h-4" />
                          补录遗漏交易
                        </button>
                        {showAddForm && (
                          <MissingTransactionForm
                            draft={draft}
                            accounts={manualAccountOptions}
                            onChange={setDraft}
                            onSave={addMissingTransaction}
                          />
                        )}
                        <label className="block text-xs text-slate-600">
                          核对说明
                          <textarea
                            value={resolutionNote}
                            onChange={(event) =>
                              setResolutionNote(event.target.value)
                            }
                            placeholder="可记录原件实际笔数、删除或补录内容"
                            className="mt-1 w-full min-h-16 border rounded-xl p-2 text-xs"
                          />
                        </label>
                        {confirmationItems.length > 0 && (
                          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <div className="text-xs font-semibold text-slate-800">页面完整性确认</div>
                            <div className="mt-2 space-y-2">
                              {confirmationItems.map(item => (
                                <label key={item} className="flex items-start gap-2 text-[11px] text-slate-700 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={confirmationChecks.includes(item)}
                                    onChange={() => setConfirmationChecks(current => current.includes(item)
                                      ? current.filter(value => value !== item)
                                      : [...current, item])}
                                    className="mt-0.5"
                                  />
                                  <span>{item}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {fieldIssueTransactions.length > 0 && !rowReviewComplete && (
                          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                            {!rowHandlingComplete
                              ? `还有 ${fieldIssueTransactions.length - reviewedRowIds.filter(id => fieldIssueTransactionIds.has(id)).length - unresolvedRowIds.filter(id => fieldIssueTransactionIds.has(id)).length} 行尚未处理。请处理完每张任务卡。`
                              : `有 ${unresolvedRowIds.filter(id => fieldIssueTransactionIds.has(id)).length} 行因原件不清晰仍无法确认，本页只能暂记为无法确认。`}
                          </div>
                        )}
                        <div className="grid grid-cols-1 gap-2">
                          <button
                            onClick={() =>
                              resolveIssueAndAdvance(
                                selectedIssue,
                                "CONFIRMED",
                                selectedCountComparison
                                  ? `已清点原件，确认实际为 ${selectedCountComparison.detailCount} 笔并保留全部明细`
                                  : "已对照原件确认本页记录正确",
                              )
                            }
                            disabled={!confirmationComplete || hasEditedReview}
                            className="bg-emerald-600 text-white rounded-xl py-2 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {selectedCountComparison
                              ? `原件确有 ${selectedCountComparison.detailCount} 笔，本页全部确认`
                              : "已逐项核对，与原件一致"}
                          </button>
                          <button
                            onClick={() =>
                              resolveIssueAndAdvance(
                                selectedIssue,
                                "CORRECTED",
                                "已根据原件完成本页全部修正",
                              )
                            }
                            disabled={!confirmationComplete || !hasEditedReview}
                            className="bg-blue-600 text-white rounded-xl py-2 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            已完成修改并复查，保存本页
                          </button>
                          {!confirmationComplete && (
                            <p className="text-center text-[10px] text-slate-500">完成上方所有逐行任务和页面确认后，才能完成本页。</p>
                          )}
                          {confirmationComplete && !hasEditedReview && (
                            <p className="text-center text-[10px] text-slate-500">如未修改任何字段，请选择“与原件一致”；修改后再使用蓝色按钮。</p>
                          )}
                          <button
                            onClick={() =>
                              resolveIssueAndAdvance(
                                selectedIssue,
                                "UNRESOLVED",
                                "原件不清晰或证据不足，暂时无法确认",
                              )
                            }
                            className="border border-amber-300 text-amber-800 rounded-xl py-2 text-xs font-medium"
                          >
                            原件不清晰／无法确认
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

type ReviewField = TransactionEvidenceField;

const TransactionReviewTask: React.FC<{
  taskNumber: number;
  transaction: StandardTransaction;
  issues: EvidenceReviewIssue[];
  reviewed: boolean;
  unresolved: boolean;
  onEdit: (id: string, field: keyof StandardTransaction, value: any) => void;
  onDecision: (decision: RowReviewDecision) => void;
}> = ({ taskNumber, transaction, issues, reviewed, unresolved, onEdit, onDecision }) => {
  const fields = reviewFieldsForTransaction(transaction, issues);
  const reason = transactionReviewReason(transaction, issues);
  const hasSuggestion = fields.some(field => {
    const evidence = transaction.fieldEvidence?.[field];
    return evidence && String(evidence.originalValue ?? "") !== String(evidence.currentValue ?? "");
  });
  return (
    <div className={`rounded-xl border p-3 space-y-3 ${reviewed ? "border-emerald-300 bg-emerald-50/50" : unresolved ? "border-amber-400 bg-amber-50/60" : "border-amber-300 bg-white"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold text-slate-900">
            任务 {taskNumber} · 尾号 {transaction.accountNumber.slice(-4)} · 第 {transaction.rawPageNumber || "?"} 页第 {transaction.rawRowIndex || "?"} 行
          </div>
          <div className="mt-1 text-[11px] text-amber-900">
            <span className="font-semibold">需要你做：</span>{reviewTaskInstruction(fields)}
          </div>
        </div>
        <span className={`flex-shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${reviewed ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
          {reviewed ? "本行已确认" : unresolved ? "本行无法确认" : "等待确认"}
        </span>
      </div>
      <div className="rounded-lg bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-100">
        <div className="mb-1 text-[10px] text-slate-400">原始识别文字</div>
        {transaction.rawText || "没有可显示的识别文字，请直接查看左侧原件对应行。"}
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
        <span className="font-semibold">为什么列出这一行：</span>{reason}
      </div>
      <div className="space-y-2">
        {fields.map(field => (
          <ReviewFieldInput
            key={field}
            field={field}
            transaction={transaction}
            onEdit={onEdit}
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2">
        {hasSuggestion && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onDecision("USE_ORIGINAL")}
              disabled={reviewed}
              className="rounded-lg border border-slate-300 bg-white py-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              原始识别值正确
            </button>
            <button
              type="button"
              onClick={() => onDecision("ACCEPT_CURRENT")}
              disabled={reviewed}
              className="rounded-lg bg-blue-600 py-2 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              采用系统建议值
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => onDecision("ACCEPT_CURRENT")}
          disabled={reviewed}
          className="w-full rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:bg-emerald-100 disabled:text-emerald-700"
        >
          {reviewed ? "这行已经核对完成" : hasSuggestion ? "我已按原件手工填写，确认本行" : "当前字段与原件一致，确认本行"}
        </button>
        <button
          type="button"
          onClick={() => onDecision("UNRESOLVED")}
          disabled={reviewed}
          className="w-full rounded-lg border border-amber-300 py-2 text-[11px] font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50"
        >
          原件看不清，暂时无法确认
        </button>
      </div>
      <p className="text-[10px] text-slate-500">如果原件是第三个数值，直接在上面填写后选择“手工填写”；系统会保留修改前后的值。</p>
    </div>
  );
};

const ReviewFieldInput: React.FC<{
  field: ReviewField;
  transaction: StandardTransaction;
  onEdit: (id: string, field: keyof StandardTransaction, value: any) => void;
}> = ({ field, transaction, onEdit }) => {
  const label = reviewFieldLabel(field);
  const hint = reviewFieldHint(field);
  const evidence = transaction.fieldEvidence?.[field];
  const hasSuggestedChange = evidence
    && String(evidence.originalValue ?? "") !== String(evidence.currentValue ?? "");
  const evidenceSummary = hasSuggestedChange ? (
    <div className="mt-1.5 rounded-md border border-amber-200 bg-white px-2 py-1.5 text-[10px] text-slate-700">
      原始识别：<span className="font-mono">{formatEvidenceValue(field, evidence.originalValue)}</span>
      <span className="mx-1.5 text-slate-400">→</span>
      系统建议：<span className="font-mono font-semibold text-blue-700">{formatEvidenceValue(field, evidence.currentValue)}</span>
      {evidence.reason && <div className="mt-1 text-slate-500">依据：{evidence.reason}</div>}
    </div>
  ) : null;
  if (field === "direction") {
    return (
      <label className="block rounded-lg border border-blue-200 bg-blue-50/50 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-blue-950">{label}</span>
          <span className="text-[10px] text-blue-700">{hint}</span>
        </div>
        {evidenceSummary}
        <select
          value={transaction.direction}
          onChange={event => onEdit(transaction.id, "direction", event.target.value)}
          className="mt-1.5 w-full rounded-lg border border-blue-300 bg-white px-2 py-2 text-xs text-slate-900"
        >
          <option value="UNKNOWN">请选择</option>
          <option value="IN">收入／贷方</option>
          <option value="OUT">支出／借方</option>
        </select>
      </label>
    );
  }
  const numeric = field === "amount" || field === "balance";
  return (
    <label className="block rounded-lg border border-blue-200 bg-blue-50/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-blue-950">{label}</span>
        <span className="text-[10px] text-blue-700">{hint}</span>
      </div>
      {evidenceSummary}
      <input
        type={numeric ? "number" : "text"}
        value={String(transaction[field] ?? "")}
        onChange={event => onEdit(transaction.id, field, numeric ? Number(event.target.value) : event.target.value)}
        className="mt-1.5 w-full rounded-lg border border-blue-300 bg-white px-2 py-2 text-xs font-semibold text-slate-900"
      />
    </label>
  );
};

function formatEvidenceValue(field: ReviewField, value: string | number | null): string {
  if (value === null || value === "") return "空白／未识别";
  if (field === "direction") return value === "IN" ? "收入" : value === "OUT" ? "支出" : "待核对";
  if ((field === "amount" || field === "balance") && typeof value === "number") return `¥${value.toLocaleString()}`;
  return String(value);
}

const TransactionEditor: React.FC<{
  transaction: StandardTransaction;
  onEdit: (id: string, field: keyof StandardTransaction, value: any) => void;
  reason?: string;
}> = ({ transaction, onEdit, reason }) => (
  <div className="border border-slate-200 rounded-xl p-3 text-xs space-y-2">
    <div className="font-semibold text-slate-800">
      第 {transaction.rawRowIndex || "?"} 笔 · {transaction.transactionTime}
    </div>
    {reason && (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">
        <span className="font-semibold">为什么要核对：</span>{reason}
      </div>
    )}
    <label className="block text-[11px] text-slate-500">
      日期时间
      <input
        value={transaction.transactionTime}
        onChange={(event) =>
          onEdit(transaction.id, "transactionTime", event.target.value)
        }
        className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
      />
    </label>
    <div className="grid grid-cols-2 gap-2">
      <label className="text-[11px] text-slate-500">
        收支方向
        <select
          value={transaction.direction}
          onChange={(event) =>
            onEdit(transaction.id, "direction", event.target.value)
          }
          className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
        >
          <option value="IN">收入</option>
          <option value="OUT">支出</option>
          <option value="UNKNOWN">待核对</option>
        </select>
      </label>
      <label className="text-[11px] text-slate-500">
        金额
        <input
          type="number"
          value={transaction.amount}
          onChange={(event) =>
            onEdit(transaction.id, "amount", Number(event.target.value))
          }
          className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
        />
      </label>
      <label className="text-[11px] text-slate-500">
        交易后余额
        <input
          type="number"
          value={transaction.balance}
          onChange={(event) =>
            onEdit(transaction.id, "balance", Number(event.target.value))
          }
          className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
        />
      </label>
      <label className="text-[11px] text-slate-500">
        对手方
        <input
          value={transaction.counterpartyName}
          onChange={(event) =>
            onEdit(transaction.id, "counterpartyName", event.target.value)
          }
          className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
        />
      </label>
    </div>
    <label className="block text-[11px] text-slate-500">
      摘要
      <input
        value={transaction.summary}
        onChange={(event) =>
          onEdit(transaction.id, "summary", event.target.value)
        }
        className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
      />
    </label>
    {transaction.rawText && (
      <div className="bg-slate-50 p-2 rounded text-[11px] text-slate-600">
        识别原文：{transaction.rawText}
      </div>
    )}
  </div>
);

const NormalTransactionPanel: React.FC<{
  transaction: StandardTransaction;
  onEdit: (id: string, field: keyof StandardTransaction, value: any) => void;
}> = ({ transaction, onEdit }) => (
  <div className="space-y-4">
    <div className="flex items-center gap-2">
      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
      <div>
        <h3 className="font-bold text-sm text-slate-900">
          自动检查未发现明确问题
        </h3>
        <p className="text-[11px] text-slate-500 mt-1">
          仍可对照左侧原件抽查；这不代表交易用途或法律事实已经证实。
        </p>
      </div>
    </div>
    <TransactionEditor transaction={transaction} onEdit={onEdit} />
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-800">
      如果抽查发现错误，直接修改字段即可，系统会将该笔标记为“已修正”。
    </div>
  </div>
);

const PageTransactionSelector: React.FC<{
  transactions: StandardTransaction[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}> = ({ transactions, selectedIds, onToggle }) => (
  <div className="border border-slate-200 rounded-xl overflow-hidden">
    <div className="px-3 py-2 bg-slate-50 border-b flex justify-between text-[11px]">
      <span className="font-semibold text-slate-700">
        当前已提取 {transactions.length} 条逐笔明细
      </span>
      <span className="text-slate-500">仅勾选重复或误识别项</span>
    </div>
    <div className="max-h-72 overflow-y-auto divide-y">
      {transactions.map((transaction, index) => (
        <label
          key={transaction.id}
          className={`flex items-center gap-2 px-3 py-2 text-[11px] cursor-pointer ${selectedIds.includes(transaction.id) ? "bg-rose-50" : "bg-white hover:bg-slate-50"}`}
        >
          <input
            type="checkbox"
            checked={selectedIds.includes(transaction.id)}
            onChange={() => onToggle(transaction.id)}
          />
          <span className="w-6 text-slate-400">{index + 1}</span>
          <span className="w-20 text-slate-600 truncate">
            {transaction.transactionTime.slice(0, 10)}
          </span>
          <span
            className={`w-12 font-medium ${transaction.direction === "IN" ? "text-emerald-700" : transaction.direction === "OUT" ? "text-rose-700" : "text-amber-700"}`}
          >
            {transaction.direction === "IN" ? "收入" : transaction.direction === "OUT" ? "支出" : "待核"}
          </span>
          <span className="w-24 text-right font-mono">
            ¥{transaction.amount.toLocaleString()}
          </span>
          <span className="flex-1 truncate text-slate-600">
            {transaction.counterpartyName ||
              transaction.summary ||
              "无对手方信息"}
          </span>
        </label>
      ))}
    </div>
  </div>
);

const MissingTransactionForm: React.FC<{
  draft: MissingTransactionDraft;
  accounts: BankAccount[];
  onChange: (draft: MissingTransactionDraft) => void;
  onSave: () => void;
}> = ({ draft, accounts, onChange, onSave }) => (
  <div className="border border-blue-200 bg-blue-50/40 rounded-xl p-3 space-y-2">
    <div className="text-xs font-semibold">根据原件补录</div>
    <select
      value={draft.accountKey}
      onChange={(event) => onChange({ ...draft, accountKey: event.target.value })}
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    >
      <option value="">选择这笔流水所属账户</option>
      {accounts.map(account => (
        <option key={accountIdentityKey(account)} value={accountIdentityKey(account)}>
          {account.bankName} · {account.accountNumber}
        </option>
      ))}
    </select>
    <input
      placeholder="日期时间，如 2023-08-09"
      value={draft.transactionTime}
      onChange={(event) =>
        onChange({ ...draft, transactionTime: event.target.value })
      }
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    />
    <div className="grid grid-cols-2 gap-2">
      <select
        value={draft.direction}
        onChange={(event) =>
          onChange({ ...draft, direction: event.target.value as "IN" | "OUT" })
        }
        className="border rounded-lg px-2 py-1.5 text-xs"
      >
        <option value="IN">收入</option>
        <option value="OUT">支出</option>
      </select>
      <input
        type="number"
        placeholder="金额"
        value={draft.amount}
        onChange={(event) => onChange({ ...draft, amount: event.target.value })}
        className="border rounded-lg px-2 py-1.5 text-xs"
      />
    </div>
    <input
      type="number"
      placeholder="交易后余额（可不填）"
      value={draft.balance}
      onChange={(event) => onChange({ ...draft, balance: event.target.value })}
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    />
    <input
      placeholder="对手方"
      value={draft.counterpartyName}
      onChange={(event) =>
        onChange({ ...draft, counterpartyName: event.target.value })
      }
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    />
    <input
      placeholder="摘要／附言"
      value={draft.summary}
      onChange={(event) => onChange({ ...draft, summary: event.target.value })}
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    />
    <button
      onClick={onSave}
      className="w-full bg-blue-600 text-white rounded-lg py-2 text-xs font-medium"
    >
      保存本笔，继续核对本页
    </button>
  </div>
);

const AuditCard: React.FC<{
  title: string;
  value: string;
  alert?: boolean;
}> = ({ title, value, alert }) => (
  <div className="bg-white rounded-xl border border-slate-200 p-4">
    <div className="text-xs text-slate-400">{title}</div>
    <div
      className={`mt-1 text-sm font-bold ${alert ? "text-rose-700" : "text-slate-800"}`}
    >
      {alert && <AlertTriangle className="w-4 h-4 inline mr-1" />}
      {value}
    </div>
  </div>
);

const BalanceFormulaItem: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] text-slate-500">{label}</div>
    <div className="mt-0.5 font-mono font-semibold text-slate-900">¥{value.toLocaleString()}</div>
  </div>
);

const ReviewExplanationRow: React.FC<{
  label: string;
  text: string;
  tone: "rose" | "amber" | "blue";
}> = ({ label, text, tone }) => {
  const colors = tone === "rose"
    ? "bg-rose-50 text-rose-900"
    : tone === "amber"
      ? "bg-amber-50 text-amber-900"
      : "bg-blue-50 text-blue-900";
  return (
    <div className={`rounded-lg px-2.5 py-2 text-[11px] leading-relaxed ${colors}`}>
      <span className="font-semibold">{label}：</span>{text}
    </div>
  );
};

interface ReviewIssueExplanation {
  detected: string;
  possible: string[];
  confirm: string[];
}

function plainIssueName(issue: EvidenceReviewIssue): string {
  const count = issue.transactionIds.length;
  switch (issue.category) {
    case "CANDIDATE_CONFLICT": return issue.title;
    case "LOW_CONFIDENCE": return `${count} 笔流水的字段需要确认`;
    case "BALANCE_BREAK": return `${count} 笔相关流水的余额接不上`;
    case "INVALID_AMOUNT": return `${count} 笔流水的金额缺失或异常`;
    case "INVALID_DATE": return `${count} 笔流水的日期不确定`;
    case "INVALID_DIRECTION": return `${count} 笔流水的收入／支出方向不确定`;
    case "PAGE_INTEGRITY": return "该页可能有漏行、重复行或页数不完整";
    case "BLANK_PAGE": return "该页可能是空白页，也可能没有识别到内容";
    default: return issue.title;
  }
}

function reviewIssueExplanation(
  issue: EvidenceReviewIssue,
  affected: StandardTransaction[],
): ReviewIssueExplanation {
  switch (issue.category) {
    case "CANDIDATE_CONFLICT": return {
      detected: issue.description, possible: ['两次读取的内容不同或其中一次漏行'],
      confirm: ['找到原件对应行', '核对列出的具体字段，填写原件值']
    };
    case "LOW_CONFIDENCE": {
      const corrected = affected.filter(transaction => transaction.correctionReason).length;
      const lowConfidence = affected.filter(transaction => (transaction.extractionConfidence ?? 1) < 0.8).length;
      return {
        detected: `${affected.length || issue.transactionIds.length} 笔流水中，${lowConfidence ? `${lowConfidence} 笔读取把握较低` : "部分字段读取把握较低"}${corrected ? `，${corrected} 笔曾按余额关系提出修正` : ""}。`,
        possible: ["扫描模糊或文字重叠", "金额与余额列位置接近", "原件字段之间存在歧义"],
        confirm: ["日期和时间", "收入或支出方向", "交易金额", "交易后余额", "对手方和摘要"],
      };
    }
    case "BALANCE_BREAK":
      return {
        detected: "按上一笔交易后余额，加上收入或减去支出后，得不到下一笔显示的余额。",
        possible: ["当前笔或上一笔金额读错", "收支方向读反", "两笔之间漏了一行", "流水顺序或账号归属错误"],
        confirm: ["同时查看前后两笔", "核对金额、方向和交易后余额", "确认两笔之间没有遗漏流水"],
      };
    case "INVALID_AMOUNT":
      return {
        detected: "交易金额为空、为零，或没有足够信息确认金额。",
        possible: ["金额没有识别出来", "该行其实是标题或说明", "确为零金额的结息／减免记录"],
        confirm: ["该行是否为真实交易", "原件发生额是多少", "如确为零金额，余额是否保持不变"],
      };
    case "INVALID_DATE":
      return {
        detected: "交易日期缺失或不是有效日期。",
        possible: ["年份或月份被遮挡", "日期跨页", "数字字符读取错误"],
        confirm: ["完整日期", "如原件有时间则一并确认", "该行是否属于本页交易"],
      };
    case "INVALID_DIRECTION":
      return {
        detected: "系统无法判断该笔应计为收入还是支出，因此尚未计入收支汇总。",
        possible: ["借贷标识模糊", "金额落在错误列", "信用卡和储蓄卡的记账口径不同"],
        confirm: ["查看原件借／贷、收入／支出栏", "结合交易前后余额判断方向", "选择收入或支出"],
      };
    case "PAGE_INTEGRITY":
      return {
        detected: issue.description,
        possible: ["页面识别中断", "表头或分页导致漏行", "同一行被重复提取"],
        confirm: ["原件实际交易行数", "系统明细是否逐行对应", "是否需要删除重复项或补录遗漏项"],
      };
    case "BLANK_PAGE":
      return {
        detected: "该页没有提取到交易内容。",
        possible: ["原件确实为空白", "只有账户说明没有流水", "页面方向、清晰度或扫描质量影响读取"],
        confirm: ["原件是否存在交易行", "如有交易则补录或重新上传清晰文件", "如确为空白可直接确认"],
      };
    default:
      return {
        detected: issue.description,
        possible: ["原件版式或内容需要人工判断"],
        confirm: issue.instructions.length ? issue.instructions : ["对照原件确认提示内容"],
      };
  }
}

function transactionReviewReason(
  transaction: StandardTransaction,
  issues: EvidenceReviewIssue[],
): string {
  const reasons: string[] = [];
  if (transaction.candidateReview) reasons.push(candidateReviewDescription(transaction));
  if ((transaction.extractionConfidence ?? 1) < 0.8) reasons.push("这笔的字段读取把握较低");
  if (transaction.correctionReason) reasons.push(transaction.correctionReason);
  if (transaction.dataQualityIssues?.includes("INVALID_AMOUNT")) reasons.push("金额未能可靠读取");
  if (transaction.dataQualityIssues?.includes("INVALID_DATE")) reasons.push("日期未能可靠读取");
  if (transaction.dataQualityIssues?.includes("UNKNOWN_DIRECTION") || transaction.direction === "UNKNOWN") reasons.push("收支方向尚未确认");
  if (issues.some(issue => issue.category === "BALANCE_BREAK" && issue.transactionIds.includes(transaction.id))) reasons.push("这笔与相邻流水的余额关系不一致");
  return [...new Set(reasons)].join("；") || "这笔属于当前页面的问题范围，请对照原件逐字段确认";
}

function pageConfirmationItems(
  issues: EvidenceReviewIssue[],
  hasRowTasks: boolean,
): string[] {
  if (!issues.length) return [];
  const items = new Set<string>();
  if (issues.some(issue => issue.category === "PAGE_INTEGRITY" || issue.category === "BLANK_PAGE"))
    items.add("我已清点原件交易行数，并确认系统没有漏行或重复行");
  if (!hasRowTasks && !items.size) items.add("我已按上方要求对照原件完成核对");
  return [...items];
}

function reviewFieldsForTransaction(
  transaction: StandardTransaction,
  issues: EvidenceReviewIssue[],
): ReviewField[] {
  const fields = new Set<ReviewField>();
  if (transaction.candidateReview?.kind === 'FIELD_CONFLICT' || transaction.candidateReview?.kind === 'SOURCE_CHECK') {
    for (const field of transaction.candidateReview.requiredFields || []) fields.add(field);
    for (const difference of transaction.candidateReview.differences) fields.add(difference.field);
  } else if (transaction.candidateReview) {
    for (const field of EVIDENCE_FIELDS) fields.add(field);
  }
  if (transaction.dataQualityIssues?.includes("INVALID_DATE") || issues.some(issue => issue.category === "INVALID_DATE"))
    fields.add(transaction.extractionMethod === "QWEN_GEMINI_QUALITY" ? "transactionDate" : "transactionTime");
  if (transaction.dataQualityIssues?.includes("UNKNOWN_DIRECTION") || transaction.direction === "UNKNOWN" || issues.some(issue => issue.category === "INVALID_DIRECTION"))
    fields.add("direction");
  if (transaction.dataQualityIssues?.includes("INVALID_AMOUNT") || transaction.amount <= 0 || issues.some(issue => issue.category === "INVALID_AMOUNT"))
    fields.add("amount");

  const correction = transaction.correctionReason || "";
  if (/日期|年份|时间/.test(correction)) fields.add("transactionTime");
  if (/方向|借贷|收支/.test(correction)) fields.add("direction");
  if (/金额|发生额/.test(correction) || transaction.originalAmount !== undefined) fields.add("amount");
  if (/余额/.test(correction) || transaction.originalBalance !== undefined) fields.add("balance");
  if (transaction.originalDirection !== undefined) fields.add("direction");

  if (issues.some(issue => issue.category === "BALANCE_BREAK")) {
    fields.add("direction");
    fields.add("amount");
    fields.add("balance");
  }
  if (issues.some(issue => issue.category === "LOW_CONFIDENCE")) {
    // A specific candidate difference does not clear a separate, unlocalized
    // extraction doubt. Keep that independent review scope visible.
    for (const field of EVIDENCE_FIELDS) fields.add(field);
  }
  if (fields.size === 0) {
    fields.add("amount");
    fields.add("balance");
  }
  return [...fields];
}

function reviewFieldLabel(field: ReviewField): string {
  const additional: Partial<Record<ReviewField, string>> = { accountName: '本方名称', bankName: '本方银行', transactionDate: '交易日期', transactionType: '交易类型', counterpartyBank: '对方银行' };
  if (additional[field]) return additional[field]!;
  return field === "accountNumber" ? "本方账号" : field === "counterpartyAccount" ? "对手方账号"
    : field === "transactionTime" ? "交易日期／时间"
    : field === "direction" ? "收入还是支出"
      : field === "amount" ? "交易金额"
        : field === "balance" ? "交易后余额"
          : field === "counterpartyName" ? "对手方"
            : "摘要／附言";
}

function reviewFieldHint(field: ReviewField): string {
  return field === "accountNumber" ? "填写原件本方账号，不要填写对手方账号"
    : field === "counterpartyAccount" ? "按原件填写对手方账号，未提供则留空"
    : field === "transactionTime" ? "填写原件中的完整日期"
    : field === "direction" ? "按借／贷或收／支栏选择"
      : field === "amount" ? "填写原件发生额"
        : field === "balance" ? "填写这一行交易后的余额"
          : field === "counterpartyName" ? "看不清可保持原样并在说明中注明"
            : "按原件填写，不要根据含义猜测";
}

function reviewTaskInstruction(fields: ReviewField[]): string {
  return `对照左侧原件，确认${fields.map(reviewFieldLabel).join("、")}；有误就直接改成原件内容。`;
}

function preserveReviewIssues(
  saved: EvidenceReviewIssue[],
  active: EvidenceReviewIssue[],
): EvidenceReviewIssue[] {
  const merged = new Map(saved.map(issue => [issue.id, issue]));
  for (const issue of active) {
    const previous = merged.get(issue.id);
    merged.set(issue.id, previous ? { ...issue, ...previous } : issue);
  }
  return [...merged.values()];
}

function statusLabel(status: ReviewIssueStatus): string {
  return status === "CONFIRMED"
    ? "已确认"
    : status === "CORRECTED"
      ? "已修正"
      : status === "UNRESOLVED"
        ? "无法确认"
        : "未核对";
}
function statusColor(status: ReviewIssueStatus): string {
  return status === "CONFIRMED"
    ? "text-emerald-700"
    : status === "CORRECTED"
      ? "text-blue-700"
      : status === "UNRESOLVED"
        ? "text-amber-700"
        : "text-rose-700";
}

type TransactionReviewState = "PENDING" | "VERIFIED" | "CORRECTED" | "AUTO";

function transactionReviewState(
  transaction: StandardTransaction,
  issues: EvidenceReviewIssue[],
): TransactionReviewState {
  if (
    issues.some(
      (issue) => issue.status === "PENDING" || issue.status === "UNRESOLVED",
    ) ||
    transaction.reviewStatus === "PENDING"
  )
    return "PENDING";
  if (
    transaction.reviewStatus === "CORRECTED" ||
    issues.some((issue) => issue.status === "CORRECTED")
  )
    return "CORRECTED";
  if (
    transaction.reviewStatus === "VERIFIED" ||
    (issues.length > 0 && issues.every((issue) => issue.status === "CONFIRMED"))
  )
    return "VERIFIED";
  return "AUTO";
}

function isTransactionLevelIssue(issue: EvidenceReviewIssue): boolean {
  return (
    issue.category === "CANDIDATE_CONFLICT" ||
    issue.category === "LOW_CONFIDENCE" ||
    issue.category === "BALANCE_BREAK" ||
    issue.category === "INVALID_AMOUNT" ||
    issue.category === "INVALID_DATE" ||
    issue.category === "INVALID_DIRECTION"
  );
}

function isOutstandingRequired(issue: EvidenceReviewIssue): boolean {
  return issue.severity === "REQUIRED"
    && (issue.status === "PENDING" || issue.status === "UNRESOLVED");
}

function issueCountComparison(
  issue: EvidenceReviewIssue,
): { summaryCount: number; detailCount: number } | undefined {
  const match =
    issue.description.match(
      /页面计数为\s*(\d+)\s*笔，逐笔提取为\s*(\d+)\s*笔/,
    ) || issue.title.match(/计数不一致（(\d+)\s*\/\s*(\d+)）/);
  return match
    ? { summaryCount: Number(match[1]), detailCount: Number(match[2]) }
    : undefined;
}

function sameReviewPage(
  left: EvidenceReviewIssue,
  right: EvidenceReviewIssue,
): boolean {
  return left.pageNumber && right.pageNumber
    ? left.pageNumber === right.pageNumber
    : left.id === right.id;
}

function reviewGroupStatus(group: EvidenceReviewGroup): ReviewIssueStatus {
  const requiredIssues = group.issues.filter(issue => issue.severity === "REQUIRED");
  const statusIssues = requiredIssues.length ? requiredIssues : group.issues;
  if (statusIssues.some((issue) => issue.status === "PENDING"))
    return "PENDING";
  if (statusIssues.some((issue) => issue.status === "UNRESOLVED"))
    return "UNRESOLVED";
  if (statusIssues.some((issue) => issue.status === "CORRECTED"))
    return "CORRECTED";
  return "CONFIRMED";
}

function transactionStateLabel(state: TransactionReviewState): string {
  return state === "PENDING"
    ? "待核对"
    : state === "CORRECTED"
      ? "已修正"
      : state === "VERIFIED"
        ? "已确认"
        : "系统校验通过";
}

function rowBackground(state: TransactionReviewState): string {
  return state === "PENDING"
    ? "bg-rose-50/70 hover:bg-rose-100/70"
    : state === "CORRECTED"
      ? "bg-blue-50/60 hover:bg-blue-100/60"
      : state === "VERIFIED"
        ? "bg-emerald-50/50 hover:bg-emerald-100/60"
        : "bg-white hover:bg-slate-50";
}

function rowBorder(state: TransactionReviewState): string {
  return state === "PENDING"
    ? "border-rose-400"
    : state === "CORRECTED"
      ? "border-blue-400"
      : state === "VERIFIED"
        ? "border-emerald-400"
        : "border-transparent";
}

function summarizeAccount(
  account: BankAccount,
  allTransactions: StandardTransaction[],
): BankAccount {
  const accountTransactions = allTransactions.filter((transaction) =>
    transactionBelongsToAccount(transaction, account) && !transaction.excludedFromAnalysis,
  );
  const dates = accountTransactions
    .map((transaction) => transaction.transactionDate)
    .filter(Boolean)
    .sort();
  return {
    ...account,
    transactionCount: accountTransactions.length,
    totalIn: accountTransactions
      .filter((transaction) => transaction.direction === "IN")
      .reduce((sum, transaction) => sum + transaction.amount, 0),
    totalOut: accountTransactions
      .filter((transaction) => transaction.direction === "OUT")
      .reduce((sum, transaction) => sum + transaction.amount, 0),
    startDate: dates[0] || account.startDate,
    endDate: dates[dates.length - 1] || account.endDate,
  };
}
