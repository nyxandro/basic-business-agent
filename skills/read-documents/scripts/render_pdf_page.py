"""Render one PDF page to PNG in .renders/ (hidden from file lists) and print its path: render_pdf_page.py <file> <page>."""
import os
import sys

import pypdfium2 as pdfium

# 150 dpi keeps small print readable for the model while the image stays a few hundred KB.
SCALE = 150 / 72
OUTPUT_DIR = ".renders"


def main() -> int:
    if len(sys.argv) != 3:
        print("Использование: render_pdf_page.py <файл> <страница>", file=sys.stderr)
        return 2
    path, page_arg = sys.argv[1], sys.argv[2]
    try:
        pdf = pdfium.PdfDocument(path)
    except Exception as error:
        print(f"Не удалось открыть PDF «{path}»: {error}", file=sys.stderr)
        return 1
    page_number = int(page_arg)
    if page_number < 1 or page_number > len(pdf):
        print(f"В документе {len(pdf)} страниц, страницы {page_number} нет", file=sys.stderr)
        return 1
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    base = os.path.splitext(os.path.basename(path))[0]
    target = os.path.join(OUTPUT_DIR, f"{base}-p{page_number}.png")
    pdf[page_number - 1].render(scale=SCALE).to_pil().save(target)
    print(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
