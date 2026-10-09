"""Private document-integrity controls. Never provide this generator/truth to the author."""
import argparse
import importlib.util
import json
import random
from decimal import Decimal
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

spec = importlib.util.spec_from_file_location("starter", Path(__file__).parents[1] / "catalog/simple-invoice/generate.py")
starter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(starter)


def document(target, role, quantity=8, price="70.00", amount=None, total=None,
             line_currency="AZN", amount_currency=None, reference=True, duplicate=False,
             supplier="Caspian Office Supplies", invoice_id="INV-2026-1042", order_id="PO-2026-0188"):
    """Keep the starter's real PDF layout, varying business facts independently."""
    target.parent.mkdir(parents=True, exist_ok=True)
    price = Decimal(price)
    amount = Decimal(amount) if amount is not None else quantity * price
    total = Decimal(total) if total is not None else amount
    c = canvas.Canvas(str(target), pagesize=A4, invariant=1, pageCompression=1)
    inv = role == "invoice"
    starter.heading(c, supplier if inv else "Northstar Studio", "Office technology and equipment | Baku, Azerbaijan" if inv else "Design and digital production | Baku, Azerbaijan",
                    "INVOICE" if inv else "PURCHASE ORDER", (invoice_id if inv else order_id) if reference else "")
    starter.text(c, starter.LEFT, 659, "BILL TO" if inv else "SUPPLIER", 8, True)
    starter.text(c, starter.LEFT, 638, "Northstar Studio" if inv else supplier, 13, True)
    starter.text(c, starter.LEFT, 619, "Design and digital production" if inv else "Office technology and equipment", 10)
    starter.text(c, starter.LEFT, 602, "Baku, Azerbaijan", 10)
    starter.text(c, 348, 659, "INVOICE DETAILS" if inv else "ORDER DETAILS", 8, True)
    starter.text(c, 348, 636, "Issue date" if inv else "Order date", 9)
    starter.right(c, starter.RIGHT, 636, "09 October 2026", 9)
    if inv:
        starter.text(c, 348, 615, "Purchase order", 9)
        starter.right(c, starter.RIGHT, 615, order_id, 9, True)
    starter.text(c, 348, 594, "Currency", 9)
    starter.right(c, starter.RIGHT, 594, "AZN", 9)
    def row(y, qty, row_amount):
        starter.text(c, starter.LEFT + 12, y, "AX1800 dual-band Wi-Fi router", 10, True)
        starter.text(c, starter.LEFT + 12, y - 18, "SKU: RTR-AX1800", 8)
        starter.right(c, 337, y, qty)
        starter.right(c, 430, y, f"{line_currency} {price}")
        starter.right(c, starter.RIGHT - 12, y, f"{amount_currency or line_currency} {row_amount}", bold=True)
    if duplicate:
        row(530, 99, Decimal(99) * price)
        row(475, quantity, amount)
    else:
        row(490, quantity, amount)
    if inv:
        starter.text(c, 345, 410, "Subtotal", 10)
        starter.right(c, starter.RIGHT - 12, 410, f"AZN {total}")
        starter.text(c, 345, 386, "Additional charges", 10)
        starter.right(c, starter.RIGHT - 12, 386, "AZN 0.00")
    starter.text(c, 345, 343, "TOTAL DUE" if inv else "ORDER TOTAL", 10, True)
    starter.right(c, starter.RIGHT - 12, 343, f"AZN {total}", 14, True)
    starter.footer(c)
    c.showPage()
    c.save()


def generate(root, seed):
    controls = [
        ("match", True, {}, {}),
        ("quantity-mismatch", False, {"quantity": 10}, {}),
        ("subcent-price", False, {"price": "70.001"}, {}),
        ("line-currency", False, {"line_currency": "USD"}, {}),
        ("amount-currency", False, {"amount_currency": "USD"}, {}),
        ("duplicate-sku", False, {"duplicate": True}, {}),
        ("line-arithmetic", False, {"quantity": 9, "amount": "560"}, {"quantity": 9, "amount": "560"}),
        ("line-sum", False, {"total": "561"}, {"total": "561"}),
        ("missing-invoice-id", False, {"reference": False}, {}),
        ("missing-order-id", False, {}, {"reference": False}),
        ("supplier-mismatch", False, {"supplier": "Different Fictional Supplier"}, {}),
        ("order-reference-mismatch", False, {"order_id": "PO-DIFFERENT"}, {}),
    ]
    rng = random.Random(seed)
    for index in range(8):
        qty = rng.randint(2, 39)
        price = str(Decimal(rng.randint(103, 9999)) / 100)
        shared = {"quantity": qty, "price": price, "supplier": f"Fictional Supplier {rng.randrange(10000, 99999)}",
                  "invoice_id": f"INV-{seed}-{index}", "order_id": f"PO-{seed}-{index}"}
        controls.append((f"fresh-match-{index + 1}", True, shared, shared))
    index = []
    for name, ready, inv, order in controls:
        folder = root / name
        document(folder / "invoice.pdf", "invoice", **inv)
        document(folder / "purchase-order.pdf", "order", **order)
        expected = {"supplier": inv.get("supplier", "Caspian Office Supplies"), "invoice_number": inv.get("invoice_id", "INV-2026-1042"),
                    "currency": "AZN", "amount": str(Decimal(inv.get("price", "70.00")) * inv.get("quantity", 8))} if ready else None
        index.append({"id": name, "expectedReady": ready, "expectedRecord": expected, "expectedOrder": inv.get("order_id", "PO-2026-0188") if ready else None, "files": [str(folder / "invoice.pdf"), str(folder / "purchase-order.pdf")]})
    index.append({"id": "missing-order", "expectedReady": False, "files": [str(root / "match/invoice.pdf")]})
    (root / "index.json").write_text(json.dumps({"seed": seed, "synthetic": True, "controls": index}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--seed", type=int, default=20261009)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    generate(args.output.resolve(), args.seed)
