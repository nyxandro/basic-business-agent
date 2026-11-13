"""Print the text of a PDF page by page: read_pdf.py <file> [--pages 1-5]."""
import argparse
import sys

from pypdf import PdfReader

# A page with less text than this is probably a scan: the agent should render and look at it.
MIN_TEXT_CHARS = 20


def parse_range(value: str, total: int) -> range:
    start, _, end = value.partition("-")
    first = max(1, int(start))
    last = min(total, int(end) if end else first)
    if first > last:
        raise ValueError(f"pages {value} are outside the document (1-{total})")
    return range(first, last + 1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    parser.add_argument("--pages", default=None)
    args = parser.parse_args()
    try:
        reader = PdfReader(args.file)
    except Exception as error:  # the message goes to the agent, which tells the person
        print(f"Не удалось открыть PDF «{args.file}»: {error}", file=sys.stderr)
        return 1
    total = len(reader.pages)
    pages = parse_range(args.pages, total) if args.pages else range(1, total + 1)
    print(f"Документ: {args.file}, страниц: {total}")
    for number in pages:
        text = (reader.pages[number - 1].extract_text() or "").strip()
        print(f"\n=== Страница {number} ===")
        if len(text) < MIN_TEXT_CHARS:
            print(f"[страница {number} похожа на скан: отрисуй её render_pdf_page.py и посмотри view_image]")
        if text:
            print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
