# Evidence-based statement recognition

The experimental pipeline extracts complete PDF pages, maps fields to their original cells, compares independent readings, and emits a 12-column CSV with separate review evidence.

## Flow

1. Render complete pages and apply only the configured orientation changes.
2. Qwen transcribes the page content. Gemini independently reads critical fields without seeing the transcription.
3. Gemini receives the complete transcription list and returns table and field mappings. The program copies the referenced values.
4. Check source coverage, account ownership, grouping and field disagreements. Perform bounded full-page rereads for unresolved evidence.
5. Preserve unresolved issues by transaction and field. The local review workspace keeps original values and manual decisions separately; unresolved mandatory issues prevent confirmed export.

The CSV contains accountNumber, accountName, bankName, transactionTime, transactionDate, direction, amount, balance, transactionType, counterpartyName, counterpartyAccount and counterpartyBank.

## Entry points

From the project root:

```text
python3 scripts/runQualityExperiment.py --pdf <private-input.pdf> --output <new-output-directory>
python3 scripts/runQualitySuite.py --inventory <input-inventory> --pdf-directory <private-pdf-directory> --output <new-output-directory>
python3 scripts/freezeQualityPolicyReplay.py --input <saved-model-output-suite> --output <new-replay-directory>
python3 scripts/evaluateQualitySuite.py --suite <frozen-output-suite> --gold-directory <private-ground-truth-directory>
python3 scripts/buildQualityReview.py --suite <frozen-output-suite> --output <local-review-directory>
npm test
npm run build
```

Qwen credentials are supplied through standard input. Gemini uses the existing local configuration. See each command's `--help` for required inputs. Python, Poppler and the repository's Node dependencies must be installed. Original data, model responses, human annotations, local reviews and credentials are excluded from version control.

The historical `experimentThreePassStatement.py` accepts optional `--shared-balance-groups <private.json>` for source-confirmed account groups; it has no embedded real account numbers. This historical experiment is separate from the current source-mapping pipeline.

## Acceptance

The agreed requirements are initial whole-transaction critical accuracy of at least 99.5%, mandatory manual review of at most 5%, and zero unalerted critical errors in an independent blind evaluation. See [acceptance definitions](product-sales-acceptance.md).

The suite evaluator reports development regression results. A result on tuned material cannot establish blind acceptance. A new independent case set, complete human truth and verified source alignment are required before making that claim. Model-reported confidence is not a calibrated correctness probability.

## Integration status

The standard CSV importer preserves multiple accounts and critical field values. Counterparty grouping prefers complete account identifiers and retains name aliases; masked or incomplete identifiers stay separate.

The command-line recognition and local review workflow are implemented. The production PDF upload entry still uses the existing recognition route; the new pipeline has not been deployed as its replacement.
