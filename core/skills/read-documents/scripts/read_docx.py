"""Print paragraphs and tables of a DOCX in document order: read_docx.py <file>."""
import sys

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph


def table_to_markdown(table: Table) -> str:
    rows = [[cell.text.strip().replace("\n", " ").replace("|", "\\|") for cell in row.cells] for row in table.rows]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) != 2:
        print("Использование: read_docx.py <файл>", file=sys.stderr)
        return 2
    try:
        document = Document(sys.argv[1])
    except Exception as error:
        print(f"Не удалось открыть документ Word «{sys.argv[1]}»: {error}", file=sys.stderr)
        return 1
    for block in document.iter_inner_content():
        if isinstance(block, Paragraph):
            text = block.text.strip()
            if text:
                print(text)
        elif isinstance(block, Table):
            print()
            print(table_to_markdown(block))
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
