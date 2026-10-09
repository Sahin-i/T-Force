# A simple invoice check

## Reviewed offline demonstration

The original AI-generated starter has a separate code-review repair in `reviewed-package.json`, with the exact embedded script also in `reviewed-compare.py`. It validates explicit invoice/order identities, all line and document currencies, finite positive quantities/prices, quantity-times-price calculations, row sums and document totals. Repeated SKUs request clarification rather than silently discarding lines. It supports one-page searchable PDFs in the labelled starter layout; arbitrary layouts and scans remain unsupported.

Open **Create workflow → Import workflow** and select `reviewed-package.json`. Import creates a new draft with disclosed code provenance and zero test reports. Upload the two starter PDFs for the sample test, inspect the actual summary, explicitly review, and publish. Python-only execution requires Docker and makes no Azure request. The original published version is immutable; archive it after a tested replacement is available.

Run `npm run verify:invoice-integrity` to reproduce the original-versus-reviewed comparison through real PDFs and isolated Docker. Controls cover missing identifiers/documents, duplicate SKUs, currency inconsistency, line arithmetic, document sums, ordinary mismatches and eight independently varied matching records. Ready-record supplier, invoice identity, currency and amount and actual protected summary contents are independently checked. Read `deliverables/evidence/invoice-integrity/report.json` for the current exact package hashes and results. The original produced six unsafe-ready results in these later controls. This is targeted regression evidence, not a general invoice-extraction benchmark. The repair is team-edited code, disclosed separately from the historical template-free live generation below.

## Original live authoring example

Start with these four sentences:

> Compare the supplier invoice with the purchase order.
> Flag any difference in quantities, prices, or totals.
> Make a short review summary showing the amount and any issues.
> Ask me to approve matching invoices before adding them to the payment list.

Attach only `invoice.pdf` and `purchase-order.pdf` from this folder. The fictional supplier, Caspian Office Supplies, invoices Northstar Studio for eight AX1800 routers at AZN 70 each. Invoice `INV-2026-1042` references purchase order `PO-2026-0188`; both total AZN 560. These are ordinary business documents. The model receives no executable template, policy document, schema or answer key.

Review the generated workflow, test it with the same two files, then publish it. Start a case with the two matching files and review its summary. Approval should add one AZN 560 entry to the local payment list. This is a demonstration queue; it does not send a payment.

For a second test, replace the invoice with `mismatch/invoice.pdf` and keep the original purchase order. That invoice charges for ten routers, totaling AZN 700. The workflow should flag the quantity and total differences and keep the case out of the payment list.

`procedure.txt` stores the four sentences for repeatable demonstrations. `generate.py` creates the PDFs with ReportLab; it is a fixture generator and is never an authoring attachment. Run it using a Python environment with ReportLab. The larger catalog and its frozen evaluation fixtures remain separate under `catalog/fixtures` and `.agent-state/validation/workflows`.

For a repeatable live UI demonstration, start the app with Azure and Docker configured, then run `node --import tsx scripts/setup-simple-workflow.ts --author-only`. It clicks Try sample and Generate workflow and retains the generated source for independent inspection under `.agent-state/validation/simple-invoice`. Check that the code reads both documents and calculates the comparison rather than embedding the sample answers. Resume with `node --import tsx scripts/setup-simple-workflow.ts --draft=<saved draft ID>` to test, publish and exercise employee approval through the UI. The script checks the matching amount, the altered invoice, a missing purchase order and duplicate prevention after the UI actions; its expected results are never authoring attachments or model instructions. Before publication, it also tests one private precision control (unit price AZN 70.001, total AZN 560.008 against the original order). That control is kept outside the public starter and only uploaded after authoring; it must be blocked or request clarification. It saves model usage, hashes, results, protected artifacts and screenshots in the same validation folder. A failed run remains a failed run in its report.

The live demonstration completed on 9 October 2026 using the configured Azure `gpt-6-luna` deployment. The first author attempt produced an invalid package; its failure and usage are retained. After generic authoring contract guidance was improved, the unchanged four sentences and two PDFs produced a valid executable workflow. All four draft tests passed before publication. The matching invoice was approved into the payment list once, the published mismatch and missing-document cases stayed out, and a second matching submission confirmed the existing entry. The original three historical queue entries were preserved. A UI selector failure after the first approval was resumed with `--finish=<saved attempt ID>`; it did not repeat publication or the original approval. The generated source, exact package hash and all attempts remain in the validation folder. These focused controls are a demonstration, not a general document-extraction benchmark.
