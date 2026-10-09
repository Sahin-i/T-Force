"""Team repair of the retained AI draft; narrow, searchable-PDF layout support.

Accepts one supplier invoice and one purchase order using the starter's labelled
layout and explicit SKU rows. Ambiguous identities, duplicate SKUs, unsupported
layouts, scanned PDFs and incomplete evidence require employee clarification.
This code never approves an invoice or writes a payment list.
"""
import json
import os
import re
from decimal import Decimal, InvalidOperation, getcontext
from pathlib import Path

getcontext().prec = 512  # Input tokens are capped at 128 digits; retain full arithmetic.
NUMBER = r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?"
HEADINGS = {
    "INVOICE", "PURCHASE ORDER", "BILL TO", "SUPPLIER", "INVOICE DETAILS",
    "ORDER DETAILS", "ISSUE DATE", "ORDER DATE", "BUYER", "CURRENCY",
    "DESCRIPTION", "QTY", "UNIT PRICE", "AMOUNT", "SUBTOTAL",
    "ADDITIONAL CHARGES", "TOTAL DUE", "ORDER TOTAL", "DELIVERY", "ORDER NOTE",
}


class DocumentError(ValueError):
    pass


def decimal_token(token, label, positive=True):
    if len(token) > 128 or not re.fullmatch(NUMBER, token):
        raise DocumentError(f"{label} is not a complete supported decimal number.")
    try:
        value = Decimal(token.replace(",", ""))
    except InvalidOperation as error:
        raise DocumentError(f"{label} is not a readable decimal number.") from error
    if not value.is_finite() or value < 0 or (positive and value == 0):
        raise DocumentError(f"{label} must be finite and {'strictly positive' if positive else 'nonnegative'}.")
    return value


def labelled_value(lines, label):
    positions = [i for i, line in enumerate(lines) if line.casefold() == label.casefold()]
    if len(positions) != 1 or positions[0] + 1 >= len(lines):
        raise DocumentError(f"Missing or ambiguous {label}.")
    value = lines[positions[0] + 1]
    if value.upper() in HEADINGS or value.startswith("SKU:"):
        raise DocumentError(f"Missing {label}; the following heading is not its value.")
    return value


def identifier(value, label):
    # A single explicit identifier token, rather than the next section's heading.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}", value) or value.upper() in HEADINGS:
        raise DocumentError(f"Missing or ambiguous {label}.")
    return value


def money(value, label, positive=True):
    match = re.fullmatch(r"([A-Z]{3})\s+(" + NUMBER + r")", value)
    if not match:
        raise DocumentError(f"{label} needs an explicit three-letter currency and complete amount.")
    return {"currency": match.group(1), "value": decimal_token(match.group(2), label, positive)}


def document_role(source, lines):
    # Cross-references in body text cannot replace the document's main heading.
    headings = [line.upper() for line in lines[:4] if line.upper() in {"INVOICE", "PURCHASE ORDER"}]
    if len(headings) != 1:
        raise DocumentError("The main invoice or purchase-order heading is missing or ambiguous.")
    role = "invoice" if headings[0] == "INVOICE" else "order"
    filename = source.get("name", "").casefold()
    named_role = "order" if "purchase-order" in filename or "purchase_order" in filename else "invoice" if "invoice" in filename else None
    if named_role and named_role != role:
        raise DocumentError("The filename and main document heading disagree about its role.")
    return role


def parse_document(lines, role):
    heading = "INVOICE" if role == "invoice" else "PURCHASE ORDER"
    number = identifier(labelled_value(lines, heading), f"{role} number")
    supplier = lines[0] if role == "invoice" else labelled_value(lines, "SUPPLIER")
    if not supplier or supplier.upper() in HEADINGS or len(supplier) > 512:
        raise DocumentError("Missing or ambiguous supplier identity.")
    currency = labelled_value(lines, "Currency")
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise DocumentError("Missing or ambiguous document currency.")
    order_number = identifier(labelled_value(lines, "Purchase order"), "invoice purchase-order reference") if role == "invoice" else number
    rows = []
    for index, line in enumerate(lines):
        if not re.match(r"^SKU\s*:", line, re.IGNORECASE):
            continue
        if index == 0 or index + 3 >= len(lines):
            raise DocumentError("An item row is incomplete.")
        sku = line.split(":", 1)[1].strip()
        description = lines[index - 1]
        if not sku or len(sku) > 128 or description.upper() in HEADINGS:
            raise DocumentError("An item lacks an explicit SKU or description.")
        quantity = decimal_token(lines[index + 1], f"{sku} quantity")
        price = money(lines[index + 2], f"{sku} unit price")
        amount = money(lines[index + 3], f"{sku} line amount")
        rows.append({"sku": sku, "description": description, "quantity": quantity, "price": price, "amount": amount})
    if not rows:
        raise DocumentError("No complete SKU rows were readable; this layout needs employee clarification.")
    total = money(labelled_value(lines, "TOTAL DUE" if role == "invoice" else "ORDER TOTAL"), f"{role} total")
    subtotal = money(labelled_value(lines, "Subtotal"), "invoice subtotal") if role == "invoice" else None
    additional = money(labelled_value(lines, "Additional charges"), "invoice additional charges", positive=False) if role == "invoice" else None
    return {"number": number, "supplier": supplier, "order_number": order_number, "currency": currency,
            "rows": rows, "total": total, "subtotal": subtotal, "additional": additional}


def main():
    outdir = Path(os.environ["WORKFLOW_OUTPUTS"])
    outdir.mkdir(parents=True, exist_ok=True)
    findings = []
    parsed = {}
    observed = {"invoice": [], "order": []}
    files = []

    def finding(code, message, source="Required documents", location="document", quote=""):
        findings.append({"code": code, "message": message, "evidence": [{"source": str(source), "location": location, "quote": str(quote)}]})

    try:
        context = json.loads(Path(os.environ["WORKFLOW_CONTEXT"]).read_text(encoding="utf-8"))
        sources = context.get("sources", [])
        if not isinstance(sources, list):
            raise DocumentError("The source list is invalid.")
        files = [source for source in sources if isinstance(source, dict) and source.get("kind") == "input"]
    except Exception as error:
        finding("input_context_unreadable", f"Could not verify the supplied document context: {error}.")

    for source in files:
        name = source.get("name", "Uploaded document")
        try:
            import pymupdf
            with pymupdf.open(source["path"]) as document:
                if not document.is_pdf or len(document) != 1:
                    raise DocumentError("This review supports one-page searchable PDFs in the labelled starter layout.")
                text = document[0].get_text()
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            if not lines:
                raise DocumentError("No searchable document text was found; scanned PDFs require employee clarification.")
            role = document_role(source, lines)
            observed[role].append(name)
            if len(observed[role]) > 1:
                finding("ambiguous_document", f"More than one {role} was uploaded; identify the authoritative document.", name)
                continue
            parsed[role] = {"source": name, **parse_document(lines, role)}
        except Exception as error:
            finding("document_unreadable", f"Could not verify {name}: {error}", name, quote=str(error))

    for role in ("invoice", "order"):
        if not observed[role]:
            label = "supplier invoice" if role == "invoice" else "purchase order"
            finding("missing_document", f"Missing a verified {label}; provide one with an explicit main heading and identity.", location="uploaded sources", quote=", ".join(str(source.get("name", "")) for source in files))

    for role, document in parsed.items():
        source = document["source"]
        currency = document["currency"]
        totals = [document["total"], document["subtotal"], document["additional"]]
        seen = set()
        for row in document["rows"]:
            sku = row["sku"]
            if sku.casefold() in seen:
                finding("ambiguous_duplicate_sku", f"{role.title()} repeats SKU {sku}; every line must be matched without silently discarding a quantity or amount.", source, "item rows", sku)
            seen.add(sku.casefold())
            if row["price"]["currency"] != currency or row["amount"]["currency"] != currency:
                finding("document_currency_inconsistent", f"{role.title()} SKU {sku} has a unit-price or line-amount currency that differs from its {currency} header.", source, "item currencies", f"{row['price']['currency']} / {row['amount']['currency']}")
            calculated = row["quantity"] * row["price"]["value"]
            if calculated != row["amount"]["value"]:
                finding("line_arithmetic_inconsistent", f"{role.title()} SKU {sku}: quantity multiplied by unit price is {calculated}, but the stated line amount is {row['amount']['value']}.", source, "line arithmetic", f"{row['quantity']} x {row['price']['value']} != {row['amount']['value']}")
        if any(value is not None and value["currency"] != currency for value in totals):
            finding("document_currency_inconsistent", f"{role.title()} header, subtotal, charges and total currencies must agree.", source, "document currencies", currency)
        row_sum = sum((row["amount"]["value"] for row in document["rows"]), Decimal(0))
        if role == "invoice":
            if row_sum != document["subtotal"]["value"]:
                finding("line_sum_inconsistent", f"Invoice line amounts sum to {row_sum}, but its subtotal is {document['subtotal']['value']}.", source, "subtotal reconciliation", str(row_sum))
            if document["subtotal"]["value"] + document["additional"]["value"] != document["total"]["value"]:
                finding("invoice_total_inconsistent", "Invoice subtotal plus additional charges does not equal its total.", source, "total reconciliation", str(document["total"]["value"]))
        elif row_sum != document["total"]["value"]:
            finding("line_sum_inconsistent", f"Purchase-order line amounts sum to {row_sum}, but its total is {document['total']['value']}.", source, "order total reconciliation", str(row_sum))

    if "invoice" in parsed and "order" in parsed:
        invoice, order = parsed["invoice"], parsed["order"]
        source = invoice["source"]
        if invoice["order_number"] != order["number"]:
            finding("order_reference_mismatch", f"Invoice purchase-order reference {invoice['order_number']} differs from order number {order['number']}.", source, "purchase-order reference", invoice["order_number"])
        if " ".join(invoice["supplier"].casefold().split()) != " ".join(order["supplier"].casefold().split()):
            finding("supplier_mismatch", f"Invoice supplier {invoice['supplier']} differs from purchase-order supplier {order['supplier']}.", source, "supplier identity", invoice["supplier"])
        if invoice["currency"] != order["currency"]:
            finding("currency_mismatch", "Invoice and purchase-order currencies differ.", source, "document currencies", f"{invoice['currency']} / {order['currency']}")
        # Duplicate rows already block readiness; never construct a lossy SKU map.
        for row in invoice["rows"]:
            matches = [candidate for candidate in order["rows"] if candidate["sku"].casefold() == row["sku"].casefold()]
            if len(matches) != 1:
                finding("item_mismatch", f"Invoice SKU {row['sku']} does not identify exactly one purchase-order row.", source, "item matching", row["sku"])
                continue
            match = matches[0]
            for field, code, label in [("quantity", "quantity_difference", "quantity"), ("price", "price_difference", "unit price"), ("amount", "line_total_difference", "line amount")]:
                if row[field] != match[field]:
                    left = row[field] if field == "quantity" else f"{row[field]['currency']} {row[field]['value']}"
                    right = match[field] if field == "quantity" else f"{match[field]['currency']} {match[field]['value']}"
                    finding(code, f"{row['sku']}: invoice {label} {left} differs from purchase-order {label} {right}.", source, label, f"{left} / {right}")
        for row in order["rows"]:
            if not any(candidate["sku"].casefold() == row["sku"].casefold() for candidate in invoice["rows"]):
                finding("item_mismatch", f"Purchase-order SKU {row['sku']} is absent from the invoice.", order["source"], "item matching", row["sku"])
        if invoice["total"] != order["total"]:
            finding("total_difference", f"Invoice total {invoice['total']['value']} differs from purchase-order total {order['total']['value']}.", source, "total comparison", str(invoice["total"]["value"]))

    complete = all(role in parsed and len(observed[role]) == 1 for role in ("invoice", "order"))
    disposition = "ready" if complete and not findings else "clarification" if any(finding["code"] in {"missing_document", "document_unreadable", "input_context_unreadable", "ambiguous_document", "ambiguous_duplicate_sku"} for finding in findings) else "blocked"
    invoice = parsed.get("invoice")
    order_document = parsed.get("order")
    amount_text = f"{invoice['currency']} {invoice['total']['value']}" if invoice else "Not available from a verified invoice"
    business_key = invoice["supplier"].strip().casefold() + "|" + invoice["number"].strip().casefold() if invoice else ""
    record = {"supplier": invoice["supplier"], "invoice_number": invoice["number"], "amount": str(invoice["total"]["value"]), "currency": invoice["currency"]} if disposition == "ready" and invoice else {}
    summary = ["# Invoice check review summary", "",
               f"Supplier: {invoice['supplier'] if invoice else 'Not available from a verified invoice'}",
               f"Invoice number: {invoice['number'] if invoice else 'Not available from a verified invoice'}",
               f"Invoice purchase-order reference: {invoice['order_number'] if invoice else 'Not available from a verified invoice'}",
               f"Purchase-order number: {order_document['number'] if order_document else 'Not available from a verified purchase order'}",
               f"Invoice amount: {amount_text}", f"Finding status: {disposition}", ""]
    summary += ["Issues:"] + [f"- {item['message']}" for item in findings] if findings else ["Issues: No differences or internal arithmetic inconsistencies found."]
    summary += ["", "Review scope: one invoice and one purchase order, each a one-page searchable PDF in the labelled starter layout with explicit SKU rows. Ambiguous duplicate lines and unsupported layouts require clarification; this is not a general invoice parser.", "", "An employee must review the actual documents and approve a matching invoice before the backend adds it to the simulated payment list. No payment or approval was performed."]
    (outdir / "invoice-review.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    result = {"businessKey": business_key, "disposition": disposition, "findings": findings, "summary": amount_text, "queueRecord": record}
    manifest = {"stepId": os.environ["WORKFLOW_STEP_ID"], "result": result, "artifacts": [{"path": "invoice-review.md", "name": "Invoice check review summary", "mime": "text/markdown"}]}
    (outdir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
