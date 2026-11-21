#!/usr/bin/env python3
"""Builds the sample letterheads of core/org-docs/fixtures (a fictional organisation): the ways real
letterheads are made, for blank.py and sign.py. Run with the Python of the skills:
.venv-skills/bin/python core/org-docs/fixtures/make_blanks.py core/org-docs/fixtures
"""
import io
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from PIL import Image, ImageDraw

ORG = 'ООО «Альфа-Строй»'
REQUISITES = 'ИНН 7700000000 · КПП 770001001 · 101000, г. Москва, ул. Примерная, д. 1 · +7 495 000-00-00'
LETTER = [
    'Уважаемый Иван Иванович!',
    'Направляем вам коммерческое предложение на поставку кровельных материалов. Цены действуют до конца месяца.',
    'С уважением,',
]


def logo() -> io.BytesIO:
    img = Image.new('RGBA', (360, 120), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 110, 110], fill=(20, 90, 160, 255))
    d.polygon([(10, 100), (55, 20), (100, 100)], fill=(255, 255, 255, 255))
    d.text((125, 40), 'ALFA-STROY', fill=(20, 90, 160, 255))
    out = io.BytesIO()
    img.save(out, 'PNG')
    out.seek(0)
    return out


def bottom_border(paragraph) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    for key, value in (('w:val', 'single'), ('w:sz', '8'), ('w:space', '1'), ('w:color', '145AA0')):
        bottom.set(qn(key), value)
    borders.append(bottom)
    p_pr.append(borders)


def page_number(paragraph) -> None:
    run = paragraph.add_run()
    for kind, text in (('begin', None), (None, ' PAGE '), ('end', None)):
        if kind:
            fld = OxmlElement('w:fldChar')
            fld.set(qn('w:fldCharType'), kind)
            run._r.append(fld)
        else:
            instr = OxmlElement('w:instrText')
            instr.text = text
            run._r.append(instr)


def letter(doc: Document, pages: int = 1) -> None:
    for _ in range(pages):
        for line in LETTER:
            doc.add_paragraph(line)
        for i in range(25 if pages > 1 else 0):
            doc.add_paragraph(f'Пункт {i + 1}: условия поставки и оплаты по договору.')


def header_footer(out: Path) -> None:
    """The usual letterhead: the logo and the name in the header, the requisites in the footer."""
    doc = Document()
    head = doc.sections[0].header.paragraphs[0]
    head.add_run().add_picture(logo(), width=Cm(4))
    head.add_run(f'   {ORG}').bold = True
    bottom_border(head)
    foot = doc.sections[0].footer.paragraphs[0]
    foot.text = REQUISITES
    foot.runs[0].font.size = Pt(8)
    letter(doc)
    doc.save(out / 'header-footer.docx')


def body_table(out: Path, mark: bool) -> None:
    """The letterhead drawn in the body: a table with the logo and the requisites, empty header and footer."""
    doc = Document()
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).paragraphs[0].add_run().add_picture(logo(), width=Cm(4))
    right = table.cell(0, 1).paragraphs[0]
    right.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    right.add_run(ORG).bold = True
    table.cell(0, 1).add_paragraph(REQUISITES).runs[0].font.size = Pt(8)
    doc.add_paragraph('Исх. № ____ от «___» __________ 20__ г.')
    if mark:
        doc.add_paragraph('[[ТЕКСТ]]')
    letter(doc)
    doc.save(out / ('body-table-mark.docx' if mark else 'body-table.docx'))


def first_page(out: Path) -> None:
    """A different first page: the full letterhead on the first, a short line on the others."""
    doc = Document()
    section = doc.sections[0]
    section.different_first_page_header_footer = True
    first = section.first_page_header.paragraphs[0]
    first.add_run().add_picture(logo(), width=Cm(5))
    first.add_run(f'\n{ORG}').bold = True
    bottom_border(first)
    section.first_page_footer.paragraphs[0].text = REQUISITES
    other = section.header.paragraphs[0]
    other.text = f'{ORG} · стр. '
    page_number(other)
    other.runs[0].font.color.rgb = RGBColor(0x80, 0x80, 0x80)
    letter(doc, pages=2)
    doc.save(out / 'first-page.docx')


def split_mark(out: Path) -> None:
    """The line [[ТЕКСТ]] cut by Word into pieces (as after a spell check), the header in paragraphs of the body."""
    doc = Document()
    name = doc.add_paragraph()
    name.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = name.add_run(ORG)
    run.bold = True
    run.font.size = Pt(16)
    req = doc.add_paragraph(REQUISITES)
    req.alignment = WD_ALIGN_PARAGRAPH.CENTER
    bottom_border(req)
    mark = doc.add_paragraph()
    for piece in ('[[', 'ТЕК', 'СТ]]'):
        mark.add_run(piece)
    letter(doc)
    doc.sections[0].footer.paragraphs[0].text = 'Стр. '
    page_number(doc.sections[0].footer.paragraphs[0])
    doc.save(out / 'split-mark.docx')


if __name__ == '__main__':
    target = Path(sys.argv[1])
    header_footer(target)
    body_table(target, mark=False)
    body_table(target, mark=True)
    first_page(target)
    split_mark(target)
