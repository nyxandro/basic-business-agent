#!/usr/bin/env python3
"""A copy of the organisation's letterhead without its text, to write a document on.

Usage: python3 blank.py BLANK.docx OUT.docx

Kept: the headers and footers, the page setup and everything above a line «[[ТЕКСТ]]» (a letterhead
drawn in the body itself: a table with the logo and the requisites). The line itself and everything
below it go; without such a line the whole body goes. The styles of the letterhead stay, so text
added to the copy takes its fonts.

Prints one line of JSON: {"mark": the line was found, "header": the headers or footers show
something, "bodyDrawing": a table or a picture was among what went}. Exit code 2 — the file is not a
Word document (a password, a broken archive).
"""
import json
import posixpath
import shutil
import sys
import zipfile
from typing import NoReturn

from lxml import etree

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
MARK = '[[ТЕКСТ]]'


def q(name):
    return f'{{{W}}}{name}'


def fail(message) -> NoReturn:
    print(json.dumps({'error': message}, ensure_ascii=False))
    sys.exit(2)


def main_part(z):
    """The name of the main document part, as the package relationships say."""
    try:
        rels = etree.fromstring(z.read('_rels/.rels'))
    except KeyError:
        fail('no _rels/.rels: not a Word document')
    for rel in rels.iter(f'{{{PKG_RELS}}}Relationship'):
        if rel.get('Type') == R_DOC:
            return rel.get('Target').lstrip('/')
    fail('no main document part')


def paragraph_text(p):
    return ''.join(t.text or '' for t in p.iter(q('t')))


def is_mark(p):
    # Spaces and case are forgiven: «[[ текст ]]» is the same line.
    return ''.join(paragraph_text(p).split()).upper() == MARK


def has_drawing(root):
    return any(True for el in root.iter() if isinstance(el.tag, str) and el.tag.endswith(('}drawing', '}pict')))


def shows_something(root):
    return any((t.text or '').strip() for t in root.iter(q('t'))) or has_drawing(root)


def drop_unpaired(body, start, end):
    """Marks of a range (bookmarks, comments) whose other half went with the removed text."""
    starts = {el.get(q('id')): el for el in body.iter(q(start))}
    ends = {el.get(q('id')): el for el in body.iter(q(end))}
    for key, el in list(starts.items()):
        if key not in ends:
            el.getparent().remove(el)
    for key, el in list(ends.items()):
        if key not in starts:
            el.getparent().remove(el)


def clean(document):
    body = document.find(q('body'))
    if body is None:
        fail('the document has no body')
    children = list(body)
    final_sect = children[-1] if children and children[-1].tag == q('sectPr') else None
    content = [el for el in children if el is not final_sect]
    at = next((i for i, el in enumerate(content) if el.tag == q('p') and is_mark(el)), None)
    removed = content if at is None else content[at:]
    body_drawing = any(el.tag == q('tbl') or has_drawing(el) for el in removed)
    for el in removed:
        body.remove(el)
    drop_unpaired(body, 'bookmarkStart', 'bookmarkEnd')
    drop_unpaired(body, 'commentRangeStart', 'commentRangeEnd')
    remaining = {el.get(q('id')) for el in body.iter(q('commentRangeStart'))}
    for ref in list(body.iter(q('commentReference'))):
        if ref.get(q('id')) not in remaining:
            run = ref.getparent()
            run.getparent().remove(run)
    return at is not None, body_drawing


def main():
    if len(sys.argv) != 3:
        print('usage: blank.py BLANK.docx OUT.docx', file=sys.stderr)
        sys.exit(1)
    source, out = sys.argv[1], sys.argv[2]
    try:
        z = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError):
        fail('not a zip archive: a password or a broken file')
    with z:
        part = main_part(z)
        try:
            document = etree.fromstring(z.read(part))
        except (KeyError, etree.XMLSyntaxError):
            fail(f'the main part {part} cannot be read')
        mark, body_drawing = clean(document)
        folder = posixpath.dirname(part)
        header = any(
            shows_something(etree.fromstring(z.read(name)))
            for name in z.namelist()
            if posixpath.dirname(name) == folder and posixpath.basename(name).startswith(('header', 'footer')) and name.endswith('.xml')
        )
        tmp = out + '.part'
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as o:
            for item in z.infolist():
                # Folder entries are dropped: Word has refused files with them opened through cloud co-editing.
                if item.filename.endswith('/'):
                    continue
                data = etree.tostring(document, xml_declaration=True, encoding='UTF-8', standalone=True) if item.filename == part else z.read(item.filename)
                o.writestr(item, data)
        shutil.move(tmp, out)
    print(json.dumps({'mark': mark, 'header': header, 'bodyDrawing': body_drawing}))


if __name__ == '__main__':
    main()
