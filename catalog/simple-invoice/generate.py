"""Generate the fictional two-document invoice example; never uploaded to the author."""
from pathlib import Path
from decimal import Decimal
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4

ROOT = Path(__file__).resolve().parent
NAVY = HexColor("#18314B")
BLUE = HexColor("#315E80")
INK = HexColor("#243746")
MUTED = HexColor("#647384")
LINE = HexColor("#DCE3E9")
PAPER = HexColor("#F4F7FA")
W, H = A4
LEFT, RIGHT = 46, W - 46


def text(c, x, y, value, size=10, bold=False, color=INK):
    c.setFillColor(color)
    c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    c.drawString(x, y, str(value))


def right(c, x, y, value, size=10, bold=False, color=INK):
    c.setFillColor(color)
    c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    c.drawRightString(x, y, str(value))


def line(c, y):
    c.setStrokeColor(LINE)
    c.setLineWidth(.6)
    c.line(LEFT, y, RIGHT, y)


def heading(c, company, subtitle, document, reference):
    c.setFillColor(NAVY)
    c.rect(0, H - 151, W, 151, fill=1, stroke=0)
    text(c, LEFT, H - 48, company, 19, True, white)
    text(c, LEFT, H - 68, subtitle, 10, False, HexColor("#D6E3EC"))
    text(c, LEFT, H - 111, document, 27, True, white)
    right(c, RIGHT, H - 111, reference, 12, True, white)


def footer(c):
    line(c, 72)
    text(c, LEFT, 53, "Fictional sample for a workflow demonstration. No real payment is due.", 8, color=MUTED)
    right(c, RIGHT, 53, "1 / 1", 8, color=MUTED)


def item_table(c, quantity, y, unit_price=Decimal("70.00")):
    c.setFillColor(PAPER)
    c.rect(LEFT, y - 31, RIGHT - LEFT, 31, fill=1, stroke=0)
    text(c, LEFT + 12, y - 20, "DESCRIPTION", 8, True, MUTED)
    right(c, 337, y - 20, "QTY", 8, True, MUTED)
    right(c, 430, y - 20, "UNIT PRICE", 8, True, MUTED)
    right(c, RIGHT - 12, y - 20, "AMOUNT", 8, True, MUTED)
    text(c, LEFT + 12, y - 60, "AX1800 dual-band Wi-Fi router", 10, True)
    text(c, LEFT + 12, y - 78, "SKU: RTR-AX1800", 8, color=MUTED)
    right(c, 337, y - 60, quantity)
    right(c, 430, y - 60, f"AZN {unit_price}")
    right(c, RIGHT - 12, y - 60, f"AZN {quantity * unit_price}", bold=True)
    line(c, y - 99)
    return y - 99


def invoice(output, quantity=8, unit_price="70.00"):
    output.parent.mkdir(parents=True, exist_ok=True)
    unit_price = Decimal(unit_price)
    total = quantity * unit_price
    c = canvas.Canvas(str(output), pagesize=A4, invariant=1, pageCompression=1)
    c.setTitle("Supplier invoice INV-2026-1042")
    c.setAuthor("Caspian Office Supplies (fictional)")
    heading(c, "Caspian Office Supplies", "Office technology and equipment | Baku, Azerbaijan", "INVOICE", "INV-2026-1042")
    text(c, LEFT, 659, "BILL TO", 8, True, MUTED)
    text(c, LEFT, 638, "Northstar Studio", 13, True)
    text(c, LEFT, 619, "Design and digital production", 10)
    text(c, LEFT, 602, "Baku, Azerbaijan", 10)
    text(c, 348, 659, "INVOICE DETAILS", 8, True, MUTED)
    text(c, 348, 636, "Issue date", 9, color=MUTED)
    right(c, RIGHT, 636, "09 October 2026", 9)
    text(c, 348, 615, "Purchase order", 9, color=MUTED)
    right(c, RIGHT, 615, "PO-2026-0188", 9, True)
    text(c, 348, 594, "Currency", 9, color=MUTED)
    right(c, RIGHT, 594, "AZN", 9)
    item_table(c, quantity, 549, unit_price)
    text(c, 345, 410, "Subtotal", 10, color=MUTED)
    right(c, RIGHT - 12, 410, f"AZN {total}")
    text(c, 345, 386, "Additional charges", 10, color=MUTED)
    right(c, RIGHT - 12, 386, "AZN 0.00")
    c.setFillColor(PAPER)
    c.rect(331, 328, RIGHT - 331, 40, fill=1, stroke=0)
    text(c, 345, 343, "TOTAL DUE", 10, True, NAVY)
    right(c, RIGHT - 12, 343, f"AZN {total}", 14, True, NAVY)
    text(c, LEFT, 264, "For the Northstar Studio office network.", 10)
    text(c, LEFT, 245, "Please quote the invoice and purchase-order references in any query.", 9, color=MUTED)
    footer(c)
    c.showPage()
    c.save()


def purchase_order(output):
    c = canvas.Canvas(str(output), pagesize=A4, invariant=1, pageCompression=1)
    c.setTitle("Purchase order PO-2026-0188")
    c.setAuthor("Northstar Studio (fictional)")
    heading(c, "Northstar Studio", "Design and digital production | Baku, Azerbaijan", "PURCHASE ORDER", "PO-2026-0188")
    text(c, LEFT, 659, "SUPPLIER", 8, True, MUTED)
    text(c, LEFT, 638, "Caspian Office Supplies", 13, True)
    text(c, LEFT, 619, "Office technology and equipment", 10)
    text(c, LEFT, 602, "Baku, Azerbaijan", 10)
    text(c, 348, 659, "ORDER DETAILS", 8, True, MUTED)
    text(c, 348, 636, "Order date", 9, color=MUTED)
    right(c, RIGHT, 636, "07 October 2026", 9)
    text(c, 348, 615, "Buyer", 9, color=MUTED)
    right(c, RIGHT, 615, "Northstar Studio", 9, True)
    text(c, 348, 594, "Currency", 9, color=MUTED)
    right(c, RIGHT, 594, "AZN", 9)
    item_table(c, 8, 549)
    text(c, LEFT, 412, "DELIVERY", 8, True, MUTED)
    text(c, LEFT, 391, "Northstar Studio office, Baku", 10)
    text(c, LEFT, 372, "One delivery of eight routers.", 9, color=MUTED)
    c.setFillColor(PAPER)
    c.rect(331, 382, RIGHT - 331, 40, fill=1, stroke=0)
    text(c, 345, 397, "ORDER TOTAL", 10, True, NAVY)
    right(c, RIGHT - 12, 397, "AZN 560.00", 14, True, NAVY)
    text(c, LEFT, 299, "ORDER NOTE", 8, True, MUTED)
    text(c, LEFT, 278, "Please include PO-2026-0188 on the supplier invoice.", 10)
    text(c, LEFT, 259, "The agreed unit price is AZN 70.00; no additional charges are ordered.", 9, color=MUTED)
    footer(c)
    c.showPage()
    c.save()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--precision-control", type=Path, help="Create only a private regression control at this path.")
    args = parser.parse_args()
    if args.precision_control:
        invoice(args.precision_control, unit_price="70.001")
        print("Created private precision control: 8 x AZN 70.001 = AZN 560.008.")
    else:
        ROOT.mkdir(parents=True, exist_ok=True)
        invoice(ROOT / "invoice.pdf")
        purchase_order(ROOT / "purchase-order.pdf")
        invoice(ROOT / "mismatch" / "invoice.pdf", quantity=10)
        print("Created two starter documents and one optional replacement invoice.")
