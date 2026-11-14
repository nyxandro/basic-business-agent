"""Print sheets of an XLSX or a CSV as Markdown tables: read_xlsx.py <file> [--sheet Name] [--max-rows 200]."""
import argparse
import csv
import sys

from openpyxl import load_workbook


def cell_text(value) -> str:
    if value is None:
        return ""
    return str(value).replace("\n", " ").replace("|", "\\|").strip()


def print_table(name: str, rows: list[list[str]], max_rows: int) -> None:
    print(f"\n=== Лист «{name}»: строк {len(rows)} ===")
    if not rows:
        return
    width = max(len(r) for r in rows)
    shown = [r + [""] * (width - len(r)) for r in rows[: max_rows + 1]]
    print("| " + " | ".join(shown[0]) + " |")
    print("|" + "---|" * width)
    for row in shown[1:]:
        print("| " + " | ".join(row) + " |")
    if len(rows) > max_rows + 1:
        print(f"[показаны первые {max_rows} строк из {len(rows) - 1}; для подсчётов по всей таблице напиши скрипт]")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    parser.add_argument("--sheet", default=None)
    parser.add_argument("--max-rows", type=int, default=200)
    args = parser.parse_args()
    try:
        if args.file.lower().endswith(".csv"):
            with open(args.file, newline="", encoding="utf-8-sig") as f:
                print_table("CSV", [[cell_text(c) for c in row] for row in csv.reader(f)], args.max_rows)
            return 0
        workbook = load_workbook(args.file, read_only=True, data_only=True)
    except Exception as error:
        print(f"Не удалось открыть таблицу «{args.file}»: {error}", file=sys.stderr)
        return 1
    names = [args.sheet] if args.sheet else workbook.sheetnames
    for name in names:
        if name not in workbook.sheetnames:
            print(f"Листа «{name}» нет. Есть: {', '.join(workbook.sheetnames)}", file=sys.stderr)
            return 1
        rows = [[cell_text(v) for v in row] for row in workbook[name].iter_rows(values_only=True)]
        while rows and not any(rows[-1]):
            rows.pop()
        print_table(name, rows, args.max_rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
