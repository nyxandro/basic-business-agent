#!/usr/bin/env python3
"""The stamp and the signature of the director put in place of the mark [[ПОДПИСЬ_РУКОВОДИТЕЛЯ]] in a Word document.

Usage: python3 sign.py IN.docx OUT.docx --position POSITION --name NAME (--stamp STAMP.png --signature SIGNATURE.png | --plain)

Run by the server in a one-off sandbox after «Да» (docs/specs/[20.11.2026]-org-letterhead.md); the pictures are never in
the agent's folder. The mark is looked for in every paragraph of the body, of the cells of tables, of text boxes, of the
headers and the footers, its pieces joined when Word cut it into several runs. In its place: the position, the signature
(a picture in the line) and the name, the stamp lying over them as on paper; on a line of its own in the body they are
spread over the line by tabs. `--plain` puts a line to sign by hand instead (the person may not sign, or nothing is
uploaded). Words around the mark stay.

Prints one line of JSON {"marks": N}. Exit code 4 — not a Word document; 3 — no mark in it (2 is argparse's own).
"""
import argparse
import copy
import json
import posixpath
import shutil
import struct
import sys
import zipfile
from typing import NoReturn

from lxml import etree

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
R_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
R_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
R_PARTS = ('http://schemas.openxmlformats.org/officeDocument/2006/relationships/header', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer')
MARK = '[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]'
XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'
HAND_LINE = '____________'
NO_MARKS = 3
NOT_A_DOCUMENT = 4

EMU_PER_CM = 360000
TWIPS_PER_CM = 567
# A signature a line and a half high, not wider than 4.5 cm; a round stamp of 4 cm, as a real one.
SIGNATURE_HEIGHT = int(1.5 * EMU_PER_CM)
SIGNATURE_MAX_WIDTH = int(4.5 * EMU_PER_CM)
STAMP_WIDTH = int(4 * EMU_PER_CM)
# A4 with margins of 3 and 1.5 cm, when the document does not say.
DEFAULT_TEXT_WIDTH = int(16.5 * TWIPS_PER_CM)
# The children of w:pPr that come before w:tabs (ECMA-376, CT_PPrBase).
BEFORE_TABS = {f'{{{W}}}{n}' for n in ('pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd')}
NSMAP = {'w': W, 'r': R, 'wp': WP, 'a': A, 'pic': PIC}


def q(ns, name):
    return f'{{{ns}}}{name}'


def fail(code, message) -> NoReturn:
    print(json.dumps({'error': message}, ensure_ascii=False))
    sys.exit(code)


def png_size(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        fail(1, 'a picture is not PNG')
    return struct.unpack('>II', data[16:24])


def own_texts(p):
    """The w:t of this paragraph itself, not of paragraphs nested in it (a text box), in order."""
    return [t for t in p.iter(q(W, 't')) if next(t.iterancestors(q(W, 'p'))) is p]


def text_width(document):
    sect = document.find(f'.//{q(W, "body")}/{q(W, "sectPr")}')
    if sect is None:
        return DEFAULT_TEXT_WIDTH
    size, margins = sect.find(q(W, 'pgSz')), sect.find(q(W, 'pgMar'))
    try:
        return int(size.get(q(W, 'w'))) - int(margins.get(q(W, 'left'))) - int(margins.get(q(W, 'right')))
    except (AttributeError, TypeError, ValueError):
        return DEFAULT_TEXT_WIDTH


class Package:
    """The archive of the document: its parts, read and written back whole."""

    def __init__(self, path):
        try:
            self.zip = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError):
            fail(NOT_A_DOCUMENT, 'not a zip archive')
        self.changed = {}
        rels = self.xml('_rels/.rels')
        main = next((r.get('Target') for r in rels.iter(q(PKG_RELS, 'Relationship')) if r.get('Type') == R_DOC), None)
        if main is None:
            fail(NOT_A_DOCUMENT, 'no main document part')
        self.main = main.lstrip('/')
        # Ids of pictures are unique over the whole document: footnotes, comments and the rest included.
        xml_parts = [n for n in self.zip.namelist() if n.startswith('word/') and n.endswith('.xml')]
        self.ids = max([int(d.get('id')) for name in xml_parts for d in self.xml(name).iter(q(WP, 'docPr')) if (d.get('id') or '').isdigit()] + [0])

    def xml(self, name):
        if name in self.changed:
            return self.changed[name]
        try:
            return etree.fromstring(self.zip.read(name))
        except KeyError:
            fail(NOT_A_DOCUMENT, f'no part {name}')
        except etree.XMLSyntaxError:
            fail(NOT_A_DOCUMENT, f'the part {name} is broken')

    def rels_name(self, part):
        return posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels')

    def parts(self):
        """The main document, then its headers and footers."""
        found = [self.main]
        rels_name = self.rels_name(self.main)
        if rels_name in self.zip.namelist():
            for rel in etree.fromstring(self.zip.read(rels_name)).iter(q(PKG_RELS, 'Relationship')):
                if rel.get('Type') in R_PARTS and rel.get('TargetMode') != 'External':
                    target = rel.get('Target')
                    # A target is relative to the folder of the part, or absolute from the root of the package.
                    found.append(target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(posixpath.dirname(self.main), target)))
        return found

    def next_id(self):
        self.ids += 1
        return self.ids

    def add_image(self, part, data, stem):
        """The picture in word/media and its relationship from the part; the id of the relationship."""
        names = set(self.zip.namelist()) | set(self.changed)
        n = 1
        while f'word/media/{stem}{n}.png' in names:
            n += 1
        media = f'word/media/{stem}{n}.png'
        self.changed[media] = data
        rels_name = self.rels_name(part)
        rels = self.xml(rels_name) if rels_name in names else etree.Element(q(PKG_RELS, 'Relationships'), nsmap={None: PKG_RELS})
        taken = {r.get('Id') for r in rels}
        rid = next(f'rIdBba{i}' for i in range(1, 10000) if f'rIdBba{i}' not in taken)
        etree.SubElement(rels, q(PKG_RELS, 'Relationship'), Id=rid, Type=R_IMAGE, Target=posixpath.relpath(media, posixpath.dirname(part)))
        self.changed[rels_name] = rels
        types = self.xml('[Content_Types].xml')
        if not any(d.get('Extension', '').lower() == 'png' for d in types.iter(q(CT, 'Default'))):
            etree.SubElement(types, q(CT, 'Default'), Extension='png', ContentType='image/png')
            self.changed['[Content_Types].xml'] = types
        return rid

    def save(self, out):
        tmp = out + '.part'
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as o:
            for item in self.zip.infolist():
                if item.filename.endswith('/') or item.filename in self.changed:
                    continue
                o.writestr(item, self.zip.read(item.filename))
            for name, value in self.changed.items():
                data = value if isinstance(value, bytes) else etree.tostring(value, xml_declaration=True, encoding='UTF-8', standalone=True)
                o.writestr(name, data)
        shutil.move(tmp, out)


def picture(rid, pid, name, cx, cy):
    graphic = etree.Element(q(A, 'graphic'), nsmap=NSMAP)
    data = etree.SubElement(graphic, q(A, 'graphicData'), uri=PIC)
    pic = etree.SubElement(data, q(PIC, 'pic'))
    nv = etree.SubElement(pic, q(PIC, 'nvPicPr'))
    etree.SubElement(nv, q(PIC, 'cNvPr'), id=str(pid), name=name)
    etree.SubElement(nv, q(PIC, 'cNvPicPr'))
    fill = etree.SubElement(pic, q(PIC, 'blipFill'))
    etree.SubElement(fill, q(A, 'blip'), {q(R, 'embed'): rid})
    etree.SubElement(etree.SubElement(fill, q(A, 'stretch')), q(A, 'fillRect'))
    sp = etree.SubElement(pic, q(PIC, 'spPr'))
    xfrm = etree.SubElement(sp, q(A, 'xfrm'))
    etree.SubElement(xfrm, q(A, 'off'), x='0', y='0')
    etree.SubElement(xfrm, q(A, 'ext'), cx=str(cx), cy=str(cy))
    etree.SubElement(etree.SubElement(sp, q(A, 'prstGeom'), prst='rect'), q(A, 'avLst'))
    return graphic


def frame(drawing_el, cx, cy):
    etree.SubElement(drawing_el, q(WP, 'extent'), cx=str(cx), cy=str(cy))
    etree.SubElement(drawing_el, q(WP, 'effectExtent'), l='0', t='0', r='0', b='0')


def inline_run(rid, pid, title, cx, cy):
    run = etree.Element(q(W, 'r'), nsmap=NSMAP)
    inline = etree.SubElement(etree.SubElement(run, q(W, 'drawing')), q(WP, 'inline'), distT='0', distB='0', distL='0', distR='0')
    frame(inline, cx, cy)
    etree.SubElement(inline, q(WP, 'docPr'), id=str(pid), name=title)
    etree.SubElement(etree.SubElement(inline, q(WP, 'cNvGraphicFramePr')), q(A, 'graphicFrameLocks'), noChangeAspect='1')
    inline.append(picture(rid, pid, title, cx, cy))
    return run


def anchor_run(rid, pid, title, cx, cy, x, y):
    """A picture over the text, placed from the place of its run: the stamp over the signature."""
    run = etree.Element(q(W, 'r'), nsmap=NSMAP)
    anchor = etree.SubElement(
        etree.SubElement(run, q(W, 'drawing')),
        q(WP, 'anchor'),
        distT='0', distB='0', distL='0', distR='0', simplePos='0', relativeHeight='251659264', behindDoc='0', locked='0', layoutInCell='1', allowOverlap='1',
    )
    etree.SubElement(anchor, q(WP, 'simplePos'), x='0', y='0')
    h = etree.SubElement(anchor, q(WP, 'positionH'), relativeFrom='character')
    etree.SubElement(h, q(WP, 'posOffset')).text = str(x)
    v = etree.SubElement(anchor, q(WP, 'positionV'), relativeFrom='line')
    etree.SubElement(v, q(WP, 'posOffset')).text = str(y)
    frame(anchor, cx, cy)
    etree.SubElement(anchor, q(WP, 'wrapNone'))
    etree.SubElement(anchor, q(WP, 'docPr'), id=str(pid), name=title)
    etree.SubElement(etree.SubElement(anchor, q(WP, 'cNvGraphicFramePr')), q(A, 'graphicFrameLocks'), noChangeAspect='1')
    anchor.append(picture(rid, pid, title, cx, cy))
    return run


def text_run(text, rpr):
    run = etree.Element(q(W, 'r'), nsmap=NSMAP)
    if rpr is not None:
        run.append(copy.deepcopy(rpr))
    t = etree.SubElement(run, q(W, 't'))
    t.text = text
    t.set(XML_SPACE, 'preserve')
    return run


def tab_run(rpr):
    run = etree.Element(q(W, 'r'), nsmap=NSMAP)
    if rpr is not None:
        run.append(copy.deepcopy(rpr))
    etree.SubElement(run, q(W, 'tab'))
    return run


def spread_by_tabs(p, width):
    """The paragraph of the signature line: a centre stop for the signature, a right one for the name, aligned left."""
    ppr = p.find(q(W, 'pPr'))
    if ppr is None:
        ppr = etree.Element(q(W, 'pPr'))
        p.insert(0, ppr)
    for old in ppr.findall(q(W, 'tabs')) + ppr.findall(q(W, 'jc')):
        ppr.remove(old)
    tabs = etree.Element(q(W, 'tabs'))
    etree.SubElement(tabs, q(W, 'tab'), {q(W, 'val'): 'center', q(W, 'pos'): str(int(width * 0.55))})
    etree.SubElement(tabs, q(W, 'tab'), {q(W, 'val'): 'right', q(W, 'pos'): str(width)})
    at = 0
    for i, child in enumerate(ppr):
        if child.tag in BEFORE_TABS:
            at = i + 1
    ppr.insert(at, tabs)


def cut_mark(texts, start):
    """Takes the characters of the mark out of the runs. Returns the run where it began, its formatting, and the words
    after the mark inside that same run — they move after the new runs."""
    end, pos, first, tail = start + len(MARK), 0, None, ''
    for t in texts:
        text = t.text or ''
        a, b = pos, pos + len(text)
        lo, hi = max(a, start), min(b, end)
        if lo < hi:
            if first is None:
                first = t
                tail = text[hi - a:]
                t.text = text[: lo - a]
            else:
                t.text = text[: lo - a] + text[hi - a :]
            # The words left around the cut may now start or end with a space: Word drops such spaces without this.
            t.set(XML_SPACE, 'preserve')
        pos = b
    run = first.getparent()
    return run, run.find(q(W, 'rPr')), tail


def sign_paragraph(pkg, part, p, document, args, images):
    texts = own_texts(p)
    full = ''.join(t.text or '' for t in texts)
    start = full.find(MARK)
    alone = full.strip() == MARK
    in_body = part == pkg.main and next(p.iterancestors(q(W, 'tc')), None) is None and next(p.iterancestors(q(W, 'txbxContent')), None) is None
    run, rpr, tail = cut_mark(texts, start)
    tabs = alone and in_body
    if tabs:
        spread_by_tabs(p, text_width(document))
    gap = (lambda: tab_run(rpr)) if tabs else (lambda: text_run(' ', rpr))
    new = []
    if args.position:
        new.append(text_run(args.position, rpr))
    new.append(gap())
    if args.plain:
        new.append(text_run(HAND_LINE, rpr))
    else:
        sig_data, stamp_data = images
        sw, sh = png_size(sig_data)
        cy = SIGNATURE_HEIGHT
        cx = int(cy * sw / sh)
        if cx > SIGNATURE_MAX_WIDTH:
            cx, cy = SIGNATURE_MAX_WIDTH, int(SIGNATURE_MAX_WIDTH * sh / sw)
        new.append(inline_run(pkg.add_image(part, sig_data, 'bba-signature'), pkg.next_id(), 'Подпись руководителя', cx, cy))
        tw, th = png_size(stamp_data)
        stamp_cx, stamp_cy = STAMP_WIDTH, int(STAMP_WIDTH * th / tw)
        # From the end of the signature: centred on it and a quarter of the stamp to the left, over the position; its
        # middle on the middle of the line, which the signature makes as high as itself.
        x = -(cx // 2) - (stamp_cx // 2) - stamp_cx // 4
        y = (cy - stamp_cy) // 2
        new.append(anchor_run(pkg.add_image(part, stamp_data, 'bba-stamp'), pkg.next_id(), 'Печать организации', stamp_cx, stamp_cy, x, y))
    new.append(gap())
    new.append(text_run(args.name, rpr))
    if tail:
        new.append(text_run(tail, rpr))
    at = run
    for el in new:
        at.addnext(el)
        at = el
    # A run the cut emptied leaves the line (its formatting went into the new runs) — only when it held nothing but text:
    # a break of a page, a field or a footnote beside the mark stays where it was.
    plain = all(child.tag in (q(W, 'rPr'), q(W, 't')) for child in run)
    if plain and not any((t.text or '') for t in run.iter(q(W, 't'))):
        run.getparent().remove(run)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source')
    ap.add_argument('out')
    ap.add_argument('--position', default='')
    ap.add_argument('--name', required=True)
    ap.add_argument('--stamp')
    ap.add_argument('--signature')
    ap.add_argument('--plain', action='store_true')
    args = ap.parse_args()
    if not args.plain and not (args.stamp and args.signature):
        fail(1, 'the stamp and the signature are needed without --plain')
    if any(s in (args.position + args.name) for s in ('[[', ']]')):
        fail(1, 'the position or the name holds brackets of a mark')
    images = None
    if not args.plain:
        with open(args.signature, 'rb') as s, open(args.stamp, 'rb') as t:
            images = (s.read(), t.read())
    pkg = Package(args.source)
    document = pkg.xml(pkg.main)
    marks = 0
    for part in pkg.parts():
        root = document if part == pkg.main else pkg.xml(part)
        touched = False
        for p in list(root.iter(q(W, 'p'))):
            while MARK in ''.join(t.text or '' for t in own_texts(p)):
                sign_paragraph(pkg, part, p, document, args, images)
                marks += 1
                touched = True
        if touched:
            pkg.changed[part] = root
    if marks == 0:
        fail(NO_MARKS, 'no mark in the document')
    # Nothing of the mark may stay in what the person sends out.
    for part in pkg.parts():
        root = pkg.changed.get(part)
        if root is not None and any(MARK in ''.join(t.text or '' for t in own_texts(p)) for p in root.iter(q(W, 'p'))):
            fail(1, 'a mark stayed after signing')
    pkg.save(args.out)
    print(json.dumps({'marks': marks}))


if __name__ == '__main__':
    main()
