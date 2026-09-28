# Evidence-based statement recognition

The experimental pipeline extracts complete PDF pages, maps fields to their original cells, compares independent readings, and emits a 12-column CSV with separate review evidence.

## Flow

1. With `--preflight`, Gemini compares four complete rotated views of each original page and selects the upright view. A page bypasses extraction only when Gemini reports blank, a conservative whole-image ink check agrees, and the PDF text layer is empty. Original page numbers remain intact. Without this option, explicit orientation settings can still be supplied.
2. Qwen transcribes the page content. Gemini independently reads critical fields without seeing the transcription. For combined bank material, `--page-context` also transcribes visible issuer headings, stamps and account context from each retained full page; these lines are appended with provenance without replacing transaction cells.
3. Gemini receives the complete transcription list and returns table and field mappings. The program copies the referenced values.
4. Check source coverage, account ownership, grouping and field disagreements. Perform bounded full-page rereads for unresolved evidence.
5. Preserve unresolved issues by transaction and field. The local review workspace keeps original values and manual decisions separately; unresolved mandatory issues prevent confirmed export.

The CSV contains accountNumber, accountName, bankName, transactionTime, transactionDate, direction, amount, balance, transactionType, counterpartyName, counterpartyAccount and counterpartyBank.

The current mapping prompt is `geminiTableMappingV7.txt`. Combined account/name cells support a `part: "account" | "name"` selector; the selected text must remain a literal source fragment. A uniquely labelled combined counterparty column can recover omitted selectors, including account-only entries. Ambiguous fragments stay required checks. A date without an actual time leaves `transactionTime` empty.

Unsigned positive amounts become income only in a signed deposit amount column corroborated by the independent reader and matching transaction anchors. Type rules include cash deposits/withdrawals and read explicit repayment/refund purpose before generic payment mechanisms; ambiguous repayments retain a candidate with a type-specific check. Cash transactions with selected empty counterparty cells, independently confirmed empty without uncertainty, do not require redundant identity confirmation.

After account recovery, remaining critical-field disagreements select at most 12 full pages for one additional image-only reading (`geminiIndependentKeysV5.txt`). A reread can resolve an independent-reader disagreement only when it agrees with a source-backed primary value, row alignment is unique, coverage/counts agree, and at least three other key fields support the match. Neither a differing new answer nor an uncertain reread is silently adopted. Original responses and before/after provenance remain recorded. Failed/deferred rereads keep required checks. `freezeQualityPolicyReplay.py` also replays any saved field-recovery responses.

Page-context extraction uses `--context-only`: a missing empty `tables` member may be normalized only for that task. Transaction extraction still rejects missing tables. Raw responses remain retained.

## Entry points

From the project root:

```text
python3 scripts/runQualityExperiment.py --pdf <private-input.pdf> --output <new-output-directory> --preflight --page-context
python3 scripts/runQualitySuite.py --inventory <input-inventory> --pdf-directory <private-pdf-directory> --output <new-output-directory>
python3 scripts/freezeQualityPolicyReplay.py --input <saved-model-output-suite> --output <new-replay-directory>
python3 scripts/evaluateQualitySuite.py --suite <frozen-output-suite> --gold-directory <private-ground-truth-directory>
python3 scripts/buildQualityReview.py --suite <frozen-output-suite> --output <local-review-directory>
npm test
python3 scripts/testPagePreflight.py
npm run build
```

Qwen credentials are supplied through standard input. Gemini uses the existing local configuration. See each command's `--help` for required inputs. Python, Poppler and the repository's Node dependencies must be installed. Original data, model responses, human annotations, local reviews and credentials are excluded from version control.

On hosts where Poppler reports missing CJK language mappings and omits Chinese text, use `STATEMENT_PDF_RENDERER=pdfium` with a Python runtime containing `pypdfium2`. This selects PDFium for preflight, initial extraction and recovery images, records the renderer in each render manifest, and preserves the complete page plus explicit rotation. Verify a rendered page before sending the batch. Poppler remains the default; the runtime selection does not change extraction prompts or field mapping rules.

The historical `experimentThreePassStatement.py` accepts optional `--shared-balance-groups <private.json>` for source-confirmed account groups; it has no embedded real account numbers. This historical experiment is separate from the current source-mapping pipeline.

Preflight responses and decisions are retained separately. `SKIPPED_BLANK` records explicitly identify pages without a full extraction call. Faint content, account information, notices and court documents remain in the recognition path. Automatic preflight cannot be combined with manual rotation overrides. Numeric page ordering is preserved beyond page 99.

Combined materials do not have a single issuer setting. An issuer may propagate to the exact same complete account when a printed page heading and the separate reader agree on the bank. Conflicting banks remain unresolved. Chinese description wrapping is ignored for type matching while source text is retained. An internal interest ledger with no confirmed issuing bank is flagged as an unresolved counterparty.

Account tables remain account evidence even if the model returns grouped rows; they cannot produce transactions. Type matching considers explicitly labelled business-type, summary and purpose columns, retaining the original cells. Account rereads prioritize directly disputed pages before supplementary inventory pages, so early pages cannot consume the entire recovery budget.

When a source page is reread, unchanged pages retain their previous mappings with all row and cell references rebased against the new registry. Model remapping is used for changed pages. A recovery that finds no readable tables may remove those candidate tables, but uncertain independent page coverage remains a required document check. Numeric row accuracy and row review-rate thresholds cannot override incomplete page coverage.

An interrupted extraction can continue in a new experiment directory with `--reuse-extractions <prior-attempt>`, optionally `--independent-results <recorded-recovery-directory>` and `--context-results <recorded-context-directory>`. Imported page responses and source manifests are fingerprinted; context images must match the current renders. This is reuse of saved model responses, not a fresh full-pipeline repetition.

`python3 scripts/testMappingStability.py` verifies field reference rebasing after an earlier page changes. `python3 scripts/evaluateWholeQualityTrial.py --trial <frozen-delivery> --gold-directory <private-truth-directory> --output <new-evaluation-directory>` compares a frozen combined-document result with the private split-document CSVs.

## Acceptance

The agreed requirements are initial whole-transaction critical accuracy of at least 99.5%, mandatory manual review of at most 5%, and zero unalerted critical errors in an independent blind evaluation. See [acceptance definitions](product-sales-acceptance.md).

The suite evaluator reports development regression results. A result on tuned material cannot establish blind acceptance. A new independent case set, complete human truth and verified source alignment are required before making that claim. Model-reported confidence is not a calibrated correctness probability.

## Integration status

The standard CSV importer preserves multiple accounts and critical field values. Counterparty grouping prefers complete account identifiers and retains name aliases; masked or incomplete identifiers stay separate.

The command-line recognition and local review workflow are implemented. The production PDF upload entry still uses the existing recognition route; the new pipeline has not been deployed as its replacement.
