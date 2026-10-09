"""Generate frozen synthetic business truth, then render independent documents.

Run with the sandbox Python or the bundled artifact Python. Answer keys are
written to --validation-dir before any business input is rendered and must never
be supplied as workflow attachments or mounted into an agent container.
"""
from pathlib import Path
from decimal import Decimal
import argparse
import copy
import csv
import hashlib
import json
import random
import shutil
import sqlite3
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
LABELS = {"invoice_number": "Hesab faktura", "supplier_id": "Təchizatçı", "po_number": "Sifariş", "currency": "Valyuta", "bank": "Bank", "sku": "Məhsul", "quantity": "Miqdar", "unit_price": "Vahid qiymət", "total": "Cəmi", "application_id": "Müraciət", "company_id": "VÖEN", "company_name": "Şirkət", "representative": "Nümayəndə", "representative_id": "Şəxsiyyət", "registration": "Qeydiyyat", "stamp": "Möhür", "authority": "Səlahiyyət", "signer_role": "İmzalayan", "valid_until": "Etibarlıdır", "complaint_id": "Şikayət", "account_id": "Abunəçi", "billing_period": "Dövr"}


def font_file():
    options = [Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), Path("/System/Library/Fonts/Supplemental/Arial.ttf"), Path("/Library/Fonts/Arial.ttf")]
    return next((path for path in options if path.exists()), None)


FONT = font_file()
if FONT:
    pdfmetrics.registerFont(TTFont("FixtureSans", str(FONT)))


def lines(fields, language):
    return [(LABELS.get(key, key.replace("_", " ").title()) if language == "az" else key.replace("_", " ").title()) + ": " + str(value) for key, value in fields.items()]


def pdf(file, title, fields, layout, language="en", scan=False):
    content = lines(fields, language)
    if layout == 1:
        content.reverse()
    elif layout == 2:
        content = content[::2] + content[1::2]
    c = canvas.Canvas(str(file), pagesize=(595, 842), invariant=1)
    if scan:
        image = Image.new("RGB", (1190, 1684), "white")
        d = ImageDraw.Draw(image)
        font = ImageFont.truetype(str(FONT), 23) if FONT else ImageFont.load_default()
        d.text((110, 110), title + "\nSynthetic demonstration document\n\n" + "\n\n".join(content), fill="black", font=font)
        from reportlab.lib.utils import ImageReader
        c.drawImage(ImageReader(image), 0, 0, width=595, height=842)
    else:
        c.setFont("FixtureSans" if FONT else "Helvetica", 16)
        c.drawString(55, 780, title)
        c.setFont("FixtureSans" if FONT else "Helvetica", 9)
        c.drawString(55, 755, "Fictional company data for a local workflow demonstration")
        c.setFont("FixtureSans" if FONT else "Helvetica", 11)
        for n, line in enumerate(content):
            c.drawString(55 if layout != 2 else 85, 715 - n * (31 if layout == 1 else 27), line)
    c.showPage()
    c.save()


def docx(file, title, paragraphs=None, fields=None, table=False, language="en"):
    d = Document()
    for section in d.sections:
        section.top_margin = section.bottom_margin = Inches(.8)
    for name in ["Title", "Heading 1", "Heading 2"]:
        d.styles[name].font.color.rgb = RGBColor(0, 0, 0)
        for border in d.styles[name]._element.xpath(".//w:pBdr"):
            border.getparent().remove(border)
    d.styles["Normal"].font.name = "Arial"
    d.styles["Normal"].font.size = Pt(11)
    d.add_paragraph(title, "Title")
    d.add_paragraph("Fictional company data and demonstration policy. No real subscriber, supplier or financial records.")
    if fields:
        if table:
            t = d.add_table(rows=0, cols=1)
            t.style = "Table Grid"
            for line in lines(fields, language):
                t.add_row().cells[0].text = line
        else:
            for line in lines(fields, language):
                d.add_paragraph(line)
    for paragraph in paragraphs or []:
        d.add_paragraph(paragraph)
    d.save(file)


def truth(id, disposition, codes, extracted=None, amount=None, letter=False):
    return {"id": id, "disposition": disposition, "findingCodes": sorted(codes), "extracted": extracted or {}, "amount": amount, "letter": letter}


def invoices(split, seed):
    rng = random.Random(seed)
    base = {"invoice_number": "INV-100", "supplier_id": "SUP-001", "po_number": "PO-100", "currency": "AZN", "bank": "AZ21DEMO000000000000001", "sku": "RTR-10", "quantity": "8", "unit_price": "70.00", "total": "560.00"}
    variants = [
        ("valid", {}, "ready", []),
        ("excess-delivery", {"quantity": "10", "total": "700.00"}, "blocked", ["excess_delivery_quantity"]),
        ("price", {"unit_price": "71.00", "total": "568.00"}, "blocked", ["price_mismatch"]),
        ("missing-bank", {"bank": None}, "clarification", ["missing_bank"]),
        ("duplicate", {"invoice_number": "INV-ALREADY"}, "blocked", ["duplicate_invoice"]),
        ("corrected", {"invoice_number": "INV-CORRECTION"}, "ready", []),
    ] if split == "development" else [
        ("valid", {}, "ready", []), ("alias", {"sku": "router"}, "ready", []),
        ("partial", {"quantity": "3", "total": "210.00"}, "ready", []),
        ("tolerance", {"total": "560.01"}, "ready", []),
        ("decimal-comma", {"unit_price": "70,00", "total": "560,00"}, "ready", []),
        ("excess-delivery", {"quantity": "10", "total": "700.00"}, "blocked", ["excess_delivery_quantity"]),
        ("excess-order", {"quantity": "11", "total": "770.00"}, "blocked", ["excess_delivery_quantity", "excess_order_quantity"]),
        ("over-prior-billing", {"quantity": "7", "total": "490.00"}, "blocked", ["excess_delivery_quantity"]),
        ("price-high", {"unit_price": "70.01", "total": "560.08"}, "blocked", ["price_mismatch"]),
        ("price-low", {"unit_price": "69.99", "total": "559.92"}, "blocked", ["price_mismatch"]),
        ("total-error", {"total": "560.02"}, "blocked", ["total_mismatch"]),
        ("currency", {"currency": "USD"}, "blocked", ["currency_mismatch"]),
        ("bank", {"bank": "AZ00WRONG"}, "blocked", ["bank_mismatch"]),
        ("supplier-po", {"supplier_id": "SUP-002", "bank": "AZ22DEMO000000000000002"}, "blocked", ["supplier_po_mismatch"]),
        ("unknown-po", {"po_number": "PO-MISSING"}, "blocked", ["unknown_po"]),
        ("ambiguous-alias", {"sku": "equipment"}, "clarification", ["ambiguous_sku"]),
        ("missing-quantity", {"quantity": None}, "clarification", ["missing_quantity"]),
        ("image-scan", {}, "ready", []),
        ("duplicate", {"invoice_number": "INV-ALREADY"}, "blocked", ["duplicate_invoice"]),
        ("correction", {"invoice_number": "INV-CORRECTION"}, "ready", []),
    ]
    records = []
    for i, (name, changes, disposition, codes) in enumerate(variants):
        fields = copy.deepcopy(base)
        fields["invoice_number"] = f"INV-{split[:3].upper()}-{seed}-{i:02d}"
        fields.update(changes)
        if name == "corrected" or split == "development" and name == "excess-delivery":
            fields["invoice_number"] = f"INV-DEV-{seed}-CORRECTION"
        elif name == "correction":
            fields["invoice_number"] = f"INV-HLD-{seed}-CORRECTION"
        fields = {key: value for key, value in fields.items() if value is not None}
        layout, language = rng.randrange(3), rng.choice(["en", "az"])
        expected_fields = copy.deepcopy(fields)
        amount = float(Decimal(fields.get("quantity", "0")) * Decimal(fields["unit_price"].replace(",", "."))) if disposition == "ready" else None
        records.append({"id": f"invoice-{i+1:02d}", "kind": "invoice", "name": name, "fields": fields, "layout": layout, "language": language, "scan": name == "image-scan", "prior": name == "over-prior-billing", "truth": truth(f"invoice-{i+1:02d}", disposition, codes, expected_fields, amount, disposition != "ready")})
        # Measure scan extraction against the actual rendered facts even though
        # conservative clarification is the expected safe business outcome.
        if name == "image-scan":
            records[-1]["truth"]["renderedFields"] = copy.deepcopy(fields)
        records[-1]["truth"]["referenceValues"] = {"orderedQuantity": 10, "deliveredQuantity": 8, "priorApprovedQuantity": 2 if name == "over-prior-billing" else 0, "remainingDeliveryQuantity": 6 if name == "over-prior-billing" else 8}
        if disposition == "ready":
            records[-1]["truth"]["queueRecord"] = {"supplierId": fields["supplier_id"], "invoiceNumber": fields["invoice_number"], "poNumber": fields["po_number"], "currency": fields["currency"], "amount": amount, "quantity": float(Decimal(fields["quantity"]))}
    return records


def onboardings(seed, split="heldout"):
    rng = random.Random(seed + 1)
    records = []
    for i, name in enumerate(["electronic-unstamped", "missing-identification", "registry-conflict", "corrected-identification", "head-no-contract-stamp", "identity-conflict"]):
        app = {"application_id": f"APP-{split[:3].upper()}-{seed}-{i+1}", "company_id": "9900001001", "company_name": "Demo Caspian Networks LLC", "representative": "Ayla Demo", "signer_role": "head" if name == "head-no-contract-stamp" else "representative", "stamp": "no"}
        if split == "development" and name in ["missing-identification", "corrected-identification"]:
            app["application_id"] = f"APP-DEV-{seed}-CORRECTION"
        extract = {"company_id": app["company_id"], "company_name": "Conflicting Demo LLC" if name == "registry-conflict" else app["company_name"], "registration": "electronic", "stamp": "no"}
        authority = {"company_id": app["company_id"], "representative": app["representative"], "representative_id": "DEMO-ID-01", "authority": "subscriber contract"}
        identity = {"representative": app["representative"], "representative_id": "DEMO-ID-99" if name == "identity-conflict" else "DEMO-ID-01", "valid_until": "2030-01-01"}
        documents = {"application": app, "extract": extract, "authority": authority}
        if name != "missing-identification":
            documents["identification"] = identity
        codes = {"missing-identification": ["missing_identification"], "registry-conflict": ["registry_conflict"], "head-no-contract-stamp": ["missing_contract_stamp"], "identity-conflict": ["identification_conflict"]}.get(name, [])
        disposition = "clarification" if name == "missing-identification" else "blocked" if codes else "ready"
        records.append({"id": f"onboarding-{i+1:02d}", "kind": "onboarding", "name": name, "documents": documents, "layout": rng.randrange(3), "language": rng.choice(["en", "az"]), "truth": truth(f"onboarding-{i+1:02d}", disposition, codes, documents, None, bool(codes))})
        if disposition == "ready":
            records[-1]["truth"]["queueRecord"] = {"applicationId": app["application_id"], "companyId": app["company_id"], "representative": app["representative"], "signatureCheck": "employee_required"}
    return records


def complaints(seed, split="heldout"):
    records = []
    for i, name in enumerate(["distinct-duplicate-charge", "legitimate", "missing-events", "missing-usage", "corrected-evidence", "already-resolved"]):
        fields = {"complaint_id": "CMP-ALREADY" if name == "already-resolved" else f"CMP-{split[:3].upper()}-{seed}-{i+1}", "account_id": "ACC-001", "billing_period": "2026-09"}
        events = [{"transaction_id": "USE-1", "event_id": "EVENT-1", "kind": "usage", "amount": "0.00", "timestamp": "2026-09-01T10:00:00Z"}, {"transaction_id": "CHARGE-1", "event_id": "EVENT-1", "kind": "charge", "amount": "12.50", "timestamp": "2026-09-01T10:01:00Z"}]
        if name in ["distinct-duplicate-charge", "corrected-evidence"]:
            events.append({"transaction_id": "CHARGE-2", "event_id": "EVENT-1", "kind": "charge", "amount": "12.50", "timestamp": "2026-09-01T10:02:00Z"})
        if name == "missing-usage":
            events = events[1:]
        for event in events:
            event.update({"account_id": fields["account_id"], "billing_period": fields["billing_period"]})
        total = "25.00" if name in ["distinct-duplicate-charge", "corrected-evidence"] else "12.50"
        codes = {"missing-events": ["missing_events"], "missing-usage": ["missing_usage_evidence"], "already-resolved": ["duplicate_resolution"]}.get(name, [])
        disposition = "escalated" if name in ["missing-events", "missing-usage"] else "blocked" if codes else "ready"
        credit = 12.5 if name in ["distinct-duplicate-charge", "corrected-evidence"] else 0
        records.append({"id": f"complaints-{i+1:02d}", "kind": "complaints", "name": name, "fields": fields, "events": events if name != "missing-events" else None, "total": total, "layout": i % 3, "language": "az" if i % 2 else "en", "truth": truth(f"complaints-{i+1:02d}", disposition, codes, fields, credit, True)})
        if disposition == "ready":
            records[-1]["truth"]["queueRecord"] = {"complaintId": fields["complaint_id"], "accountId": fields["account_id"], "creditAmount": credit, "currency": "AZN", "resolution": "credit_duplicate" if credit else "explain_legitimate"}
    return records


def invoice_references(directory, prior=False):
    w = Workbook()
    s = w.active
    s.title = "Orders"
    s.append(["po_number", "supplier_id", "sku", "quantity", "unit_price"])
    s.append(["PO-100", "SUP-001", "RTR-10", 10, 70])
    s.append(["PO-100", "SUP-001", "CABLE-1", 20, 5])
    for cell in s[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1E3A5F")
    for column in ["A", "B", "C", "D", "E"]:
        s.column_dimensions[column].width = 22
    w.save(directory / "purchase-orders.xlsx")
    p = directory / "supplier-records.sqlite"
    p.unlink(missing_ok=True)
    conn = sqlite3.connect(p)
    conn.executescript("CREATE TABLE suppliers(supplier_id TEXT PRIMARY KEY,bank TEXT); CREATE TABLE deliveries(po_number TEXT,sku TEXT,quantity INTEGER); CREATE TABLE billing(supplier_id TEXT,invoice_number TEXT,po_number TEXT,sku TEXT,quantity INTEGER,approved INTEGER); CREATE TABLE aliases(alias TEXT,sku TEXT);")
    conn.executemany("INSERT INTO suppliers VALUES(?,?)", [("SUP-001", "AZ21DEMO000000000000001"), ("SUP-002", "AZ22DEMO000000000000002")])
    conn.executemany("INSERT INTO deliveries VALUES(?,?,?)", [("PO-100", "RTR-10", 8), ("PO-100", "CABLE-1", 20)])
    conn.executemany("INSERT INTO aliases VALUES(?,?)", [("router", "RTR-10"), ("equipment", "RTR-10"), ("equipment", "CABLE-1")])
    conn.execute("INSERT INTO billing VALUES(?,?,?,?,?,?)", ("SUP-001", "INV-ALREADY", "PO-OLD", "RTR-10", 8, 1))
    if prior:
        conn.execute("INSERT INTO billing VALUES(?,?,?,?,?,?)", ("SUP-001", "INV-PRIOR", "PO-100", "RTR-10", 2, 1))
    conn.commit()
    conn.close()


def other_references(directory, kind):
    file = directory / ("registry.sqlite" if kind == "onboarding" else "accounts.sqlite")
    file.unlink(missing_ok=True)
    conn = sqlite3.connect(file)
    if kind == "onboarding":
        conn.execute("CREATE TABLE registry(company_id TEXT PRIMARY KEY,company_name TEXT)")
        conn.execute("INSERT INTO registry VALUES(?,?)", ("9900001001", "Demo Caspian Networks LLC"))
    else:
        conn.executescript("CREATE TABLE accounts(account_id TEXT PRIMARY KEY,name TEXT); CREATE TABLE payments(account_id TEXT,payment_id TEXT,amount NUMERIC,timestamp TEXT); CREATE TABLE resolutions(complaint_id TEXT PRIMARY KEY);")
        conn.execute("INSERT INTO accounts VALUES(?,?)", ("ACC-001", "Demo Subscriber"))
        conn.execute("INSERT INTO payments VALUES(?,?,?,?)", ("ACC-001", "PAY-1", 12.5, "2026-09-10T09:00:00Z"))
        conn.execute("INSERT INTO resolutions VALUES(?)", ("CMP-ALREADY",))
    conn.commit()
    conn.close()


POLICIES = {
    "invoice": ["Match supplier and purchase order. Use exactly one SKU or approved alias. Invoice quantity must not exceed ordered quantity or delivery quantity after subtracting approved billing. Require the exact agreed unit price.", "Approve AZN and registered supplier bank details only. Calculate quantity times price; the difference from the declared invoice total must be at most AZN 0.01. Compare full finite Decimal precision without rounding the unit price or declared total first. Round only final displayed or queued currency amounts. NaN or Infinity and missing, unreadable, ambiguous or conflicting evidence require clarification.", "The supplier identifier and invoice number form the accounting business key. A duplicate must not create another queue record. Generate a correction letter on any discrepancy and an XLSX review row for every completed investigation. An employee must review before accounting queue insertion."],
    "onboarding": ["Compare application, legal-entity extract, representative identification and authority with the registry snapshot. Request the representative identification specifically when it is missing. Power of attorney must authorize a subscriber contract.", "Electronic registration extracts have no stamp and must be compared with registry data. A contract signed by the company head requires a company stamp. A contract signed by an authorized representative does not require a stamp. Optional bank and tax-certificate documents are not mandatory in this fictional procedure.", "Only unexpired identification is accepted as of snapshot date 2026-10-09. Signature authenticity and original authority remain employee checks. Employee approval is mandatory before a simulated provisioning entry."],
    "complaints": ["This credit policy is fictional and is not Azercell policy. Reconcile the invoice, CSV charge and usage evidence, account and payment snapshot. Consider only the complaint account and billing period.", "Two distinct charge transaction IDs for the same billable event are a duplicate: retain the earliest transaction and recommend the sum of later charges as credit. Repeated copies of the same transaction are not another charge. Conflicting transaction evidence or absent usage evidence requires escalation.", "Missing complaint identification requires clarification. Missing events require escalation. Supported legitimate charges require an explanation and a zero-credit resolution. Employee approval is required before a simulated resolution or credit queue entry; a complaint already resolved must not commit again."]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "catalog" / "fixtures")
    parser.add_argument("--validation-dir", type=Path, default=ROOT / ".agent-state" / "validation" / "workflows")
    parser.add_argument("--seed", type=int, default=20261009)
    parser.add_argument("--truth-only", action="store_true", help="Refresh grader metadata for the same frozen seed without changing rendered files")
    args = parser.parse_args()
    suites = {"invoice-development": invoices("development", args.seed), "invoice-heldout": invoices("heldout", args.seed), "onboarding-development": onboardings(args.seed, "development"), "onboarding-heldout": onboardings(args.seed), "complaints-development": complaints(args.seed, "development"), "complaints-heldout": complaints(args.seed)}
    args.validation_dir.mkdir(parents=True, exist_ok=True)
    # Commit all structured truth first, independently of rendering and execution.
    for suite, records in suites.items():
        (args.validation_dir / (suite + ".json")).write_text(json.dumps({"seed": args.seed, "suite": suite, "truth": [r["truth"] for r in records]}, ensure_ascii=False, indent=2))
    if args.truth_only:
        print(json.dumps({"seed": args.seed, "truthScenarios": sum(len(records) for records in suites.values()), "answerDirectory": str(args.validation_dir), "renderedFilesChanged": False}))
        return
    public_index = []
    for suite, records in suites.items():
        for record in records:
            directory = args.output_dir / suite / record["id"]
            directory.mkdir(parents=True, exist_ok=True)
            kind = record["kind"]
            if kind == "invoice":
                pdf(directory / "invoice.pdf", "Supplier invoice", record["fields"], record["layout"], record["language"], record["scan"])
                invoice_references(directory, record["prior"])
            elif kind == "onboarding":
                for name, fields in record["documents"].items():
                    docx(directory / (name + ".docx"), name.title() + " document", fields=fields, table=record["layout"] == 1, language=record["language"])
                other_references(directory, kind)
            else:
                docx(directory / "complaint.docx", "Billing complaint", fields=record["fields"], table=record["layout"] == 1, language=record["language"])
                pdf(directory / "invoice.pdf", "Subscriber bill", {"account_id": record["fields"]["account_id"], "billing_period": "2026-09", "total": record["total"]}, record["layout"], record["language"])
                if record["events"] is not None:
                    with (directory / "events.csv").open("w", newline="", encoding="utf-8") as file:
                        writer = csv.DictWriter(file, fieldnames=list(record["events"][0]))
                        writer.writeheader()
                        writer.writerows(record["events"])
                other_references(directory, kind)
            docx(directory / ("procedure.docx" if kind == "onboarding" else "policy.docx"), kind.title() + " demonstration procedure", POLICIES[kind])
            docx(directory / "letter-template.docx", "Employee reviewed correspondence template", ["Use a clear title, the business reference, evidence and the specific requested correction. This output is a draft and is not sent automatically."])
            files = sorted(p for p in directory.iterdir() if p.is_file())
            public_index.append({"suite": suite, "id": record["id"], "kind": kind, "language": record["language"], "layout": record["layout"], "files": [{"path": str(p.relative_to(args.output_dir)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]})
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "index.json").write_text(json.dumps({"seed": args.seed, "synthetic": True, "answerKeys": "Backend validation directory only; never mounted", "scenarios": public_index}, ensure_ascii=False, indent=2))
    print(json.dumps({"seed": args.seed, "scenarios": len(public_index), "inputDirectory": str(args.output_dir), "answerDirectory": str(args.validation_dir)}))


if __name__ == "__main__":
    main()
