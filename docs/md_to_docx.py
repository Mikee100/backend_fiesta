"""Convert AI_ENGINE_DEEP_DIVE.md to a professional Word document."""
from __future__ import annotations

import re
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.shared import Inches, Pt, RGBColor, Cm, Twips
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.style import WD_STYLE_TYPE

ROOT = Path(__file__).resolve().parent
MD_PATH = ROOT / "AI_ENGINE_DEEP_DIVE.md"
DOCX_PATH = ROOT / "Fiesta_AI_Engine_Technical_Reference.docx"

NAVY = RGBColor(0x1A, 0x2B, 0x4A)
ACCENT = RGBColor(0x2C, 0x5F, 0x8A)
MUTED = RGBColor(0x55, 0x55, 0x55)
CODE_BG = "F4F6F8"
TABLE_HEADER_BG = "1A2B4A"
TABLE_ALT_BG = "F0F3F7"


def set_run_font(run, name="Calibri", size=11, bold=False, italic=False, color=None, mono=False):
    run.font.name = "Consolas" if mono else name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), run.font.name)
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    if color is not None:
        run.font.color.rgb = color


def set_paragraph_spacing(paragraph, before=0, after=8, line=1.15):
    pf = paragraph.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = line


def shade_cell(cell, hex_color: str):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), hex_color)
    shd.set(qn("w:val"), "clear")
    tcPr.append(shd)


def set_cell_borders(cell):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:color"), "CBD2DC")
        borders.append(el)
    tcPr.append(borders)


def add_horizontal_rule(doc: Document):
    p = doc.add_paragraph()
    set_paragraph_spacing(p, before=6, after=12)
    pPr = p._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "12")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "1A2B4A")
    pBdr.append(bottom)
    pPr.append(pBdr)


INLINE_RE = re.compile(
    r"(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))"
)


def add_inline_runs(paragraph, text: str, base_size=11, base_color=None):
    if not text:
        return
    parts = INLINE_RE.split(text)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            run = paragraph.add_run(part[2:-2])
            set_run_font(run, size=base_size, bold=True, color=base_color or NAVY)
        elif part.startswith("`") and part.endswith("`"):
            run = paragraph.add_run(part[1:-1])
            set_run_font(run, size=base_size - 1, mono=True, color=RGBColor(0x1E, 0x3A, 0x5F))
        elif part.startswith("*") and part.endswith("*") and not part.startswith("**"):
            run = paragraph.add_run(part[1:-1])
            set_run_font(run, size=base_size, italic=True, color=base_color)
        elif part.startswith("[") and "](" in part:
            label = part[1 : part.index("]")]
            run = paragraph.add_run(label)
            set_run_font(run, size=base_size, color=ACCENT)
            run.underline = True
        else:
            run = paragraph.add_run(part)
            set_run_font(run, size=base_size, color=base_color)


def add_code_block(doc: Document, code: str, language: str = ""):
    # Label for mermaid diagrams
    if language.strip().lower() == "mermaid":
        p = doc.add_paragraph()
        set_paragraph_spacing(p, before=8, after=4)
        run = p.add_run("Diagram (Mermaid source)")
        set_run_font(run, size=9, italic=True, color=MUTED)

    for line in code.rstrip("\n").split("\n") or [""]:
        p = doc.add_paragraph()
        set_paragraph_spacing(p, before=0, after=0, line=1.05)
        pf = p.paragraph_format
        pf.left_indent = Cm(0.3)
        # Light background via shading on paragraph
        pPr = p._p.get_or_add_pPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:fill"), CODE_BG)
        shd.set(qn("w:val"), "clear")
        pPr.append(shd)
        run = p.add_run(line if line else " ")
        set_run_font(run, size=9, mono=True, color=RGBColor(0x22, 0x22, 0x22))

    spacer = doc.add_paragraph()
    set_paragraph_spacing(spacer, before=0, after=8)


def parse_table_row(line: str) -> list[str]:
    line = line.strip().strip("|")
    return [c.strip() for c in line.split("|")]


def is_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells)


def add_table(doc: Document, rows: list[list[str]]):
    if not rows:
        return
    cols = max(len(r) for r in rows)
    # Normalize row widths
    norm = [r + [""] * (cols - len(r)) for r in rows]
    table = doc.add_table(rows=len(norm), cols=cols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True

    for i, row_cells in enumerate(norm):
        for j, text in enumerate(row_cells):
            cell = table.cell(i, j)
            cell.text = ""
            p = cell.paragraphs[0]
            set_paragraph_spacing(p, before=2, after=2, line=1.1)
            clean = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
            clean = re.sub(r"`([^`]+)`", r"\1", clean)
            clean = re.sub(r"\*([^*]+)\*", r"\1", clean)
            run = p.add_run(clean)
            if i == 0:
                set_run_font(run, size=9, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
                shade_cell(cell, TABLE_HEADER_BG)
            else:
                set_run_font(run, size=9, color=RGBColor(0x22, 0x22, 0x22))
                if i % 2 == 0:
                    shade_cell(cell, TABLE_ALT_BG)
            set_cell_borders(cell)

    spacer = doc.add_paragraph()
    set_paragraph_spacing(spacer, before=4, after=10)


def configure_styles(doc: Document):
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.font.color.rgb = RGBColor(0x22, 0x22, 0x22)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Calibri")

    for style_name, size, color, before, after in [
        ("Heading 1", 18, NAVY, 18, 8),
        ("Heading 2", 14, ACCENT, 14, 6),
        ("Heading 3", 12, NAVY, 10, 4),
    ]:
        style = doc.styles[style_name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = color
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)


def add_title_page(doc: Document):
    for _ in range(3):
        doc.add_paragraph()

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run("Fiesta AI Engine")
    set_run_font(run, size=32, bold=True, color=NAVY)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_paragraph_spacing(subtitle, before=6, after=24)
    run = subtitle.add_run("Technical Reference")
    set_run_font(run, size=20, color=ACCENT)

    add_horizontal_rule(doc)

    meta_items = [
        ("System", "Fiesta House Maternity AI Assistant"),
        ("Codebase", "backend 2.0"),
        ("Audience", "Engineers, operators, and technical stakeholders"),
        ("Source of truth", "Live application source"),
        ("Last reviewed", "September 2026"),
    ]
    for label, value in meta_items:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        set_paragraph_spacing(p, before=2, after=2)
        r1 = p.add_run(f"{label}: ")
        set_run_font(r1, size=11, bold=True, color=NAVY)
        r2 = p.add_run(value)
        set_run_font(r2, size=11, color=MUTED)

    doc.add_page_break()


def convert():
    text = MD_PATH.read_text(encoding="utf-8")
    lines = text.splitlines()

    doc = Document()
    section = doc.sections[0]
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.2)
    section.left_margin = Cm(2.2)
    section.right_margin = Cm(2.2)

    # Footer with page numbers
    footer = section.footer
    footer.is_linked_to_previous = False
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = fp.add_run("Fiesta AI Engine — Technical Reference  |  Page ")
    set_run_font(run, size=8, color=MUTED)
    # PAGE field
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    fld_sep = OxmlElement("w:fldChar")
    fld_sep.set(qn("w:fldCharType"), "separate")
    fld_text = OxmlElement("w:t")
    fld_text.text = "1"
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    r = fp.add_run()._r
    r.append(fld_begin)
    r.append(instr)
    r.append(fld_sep)
    r.append(fld_text)
    r.append(fld_end)

    configure_styles(doc)
    add_title_page(doc)

    i = 0
    # Skip leading H1 and the metadata table / purpose / contents until first ## —
    # we'll render everything from the MD, but skip the duplicate title block at top
    # by detecting and lightly handling it.

    skip_until_purpose = False
    in_code = False
    code_lang = ""
    code_lines: list[str] = []
    table_rows: list[list[str]] | None = None

    def flush_table():
        nonlocal table_rows
        if table_rows:
            # Drop separator row if present as first data after header
            cleaned = [table_rows[0]]
            for r in table_rows[1:]:
                if not is_separator_row(r):
                    cleaned.append(r)
            add_table(doc, cleaned)
        table_rows = None

    while i < len(lines):
        line = lines[i]

        # Code fence
        if line.startswith("```"):
            if in_code:
                add_code_block(doc, "\n".join(code_lines), code_lang)
                in_code = False
                code_lines = []
                code_lang = ""
            else:
                flush_table()
                in_code = True
                code_lang = line[3:].strip()
                code_lines = []
            i += 1
            continue

        if in_code:
            code_lines.append(line)
            i += 1
            continue

        # Table lines
        if line.strip().startswith("|") and "|" in line.strip()[1:]:
            cells = parse_table_row(line)
            if table_rows is None:
                table_rows = []
            table_rows.append(cells)
            i += 1
            # Peek: if next isn't a table, flush
            if i >= len(lines) or not lines[i].strip().startswith("|"):
                flush_table()
            continue
        else:
            flush_table()

        # Horizontal rule
        if re.fullmatch(r"-{3,}", line.strip()) or re.fullmatch(r"\*{3,}", line.strip()):
            add_horizontal_rule(doc)
            i += 1
            continue

        # Empty line
        if not line.strip():
            i += 1
            continue

        # Headings
        if line.startswith("# "):
            # Skip top H1 — title page covers it
            i += 1
            continue
        if line.startswith("## "):
            heading = line[3:].strip()
            # Drop TOC anchor noise like "1. Architecture overview"
            p = doc.add_heading(heading, level=1)
            for run in p.runs:
                set_run_font(run, size=18, bold=True, color=NAVY)
            i += 1
            continue
        if line.startswith("### "):
            p = doc.add_heading(line[4:].strip(), level=2)
            for run in p.runs:
                set_run_font(run, size=14, bold=True, color=ACCENT)
            i += 1
            continue
        if line.startswith("#### "):
            p = doc.add_heading(line[5:].strip(), level=3)
            for run in p.runs:
                set_run_font(run, size=12, bold=True, color=NAVY)
            i += 1
            continue

        # Blockquote
        if line.startswith(">"):
            quote_lines = []
            while i < len(lines) and lines[i].startswith(">"):
                quote_lines.append(re.sub(r"^>\s?", "", lines[i]))
                i += 1
            p = doc.add_paragraph()
            set_paragraph_spacing(p, before=6, after=8)
            p.paragraph_format.left_indent = Cm(0.5)
            pPr = p._p.get_or_add_pPr()
            pBdr = OxmlElement("w:pBdr")
            left = OxmlElement("w:left")
            left.set(qn("w:val"), "single")
            left.set(qn("w:sz"), "18")
            left.set(qn("w:space"), "8")
            left.set(qn("w:color"), "2C5F8A")
            pBdr.append(left)
            pPr.append(pBdr)
            add_inline_runs(p, " ".join(quote_lines), base_size=10, base_color=MUTED)
            continue

        # Unordered list
        if re.match(r"^[-*]\s+", line):
            while i < len(lines) and re.match(r"^[-*]\s+", lines[i]):
                item = re.sub(r"^[-*]\s+", "", lines[i])
                p = doc.add_paragraph(style="List Bullet")
                set_paragraph_spacing(p, before=1, after=2)
                add_inline_runs(p, item)
                i += 1
            continue

        # Ordered list
        if re.match(r"^\d+\.\s+", line):
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i]):
                item = re.sub(r"^\d+\.\s+", "", lines[i])
                p = doc.add_paragraph(style="List Number")
                set_paragraph_spacing(p, before=1, after=2)
                add_inline_runs(p, item)
                i += 1
            continue

        # Italic-only end marker like *End of document.*
        if line.strip().startswith("*") and line.strip().endswith("*") and line.count("*") == 2:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            set_paragraph_spacing(p, before=18, after=6)
            run = p.add_run(line.strip().strip("*"))
            set_run_font(run, size=10, italic=True, color=MUTED)
            i += 1
            continue

        # Normal paragraph (may continue)
        para_parts = [line.strip()]
        i += 1
        while i < len(lines):
            nxt = lines[i]
            if (
                not nxt.strip()
                or nxt.startswith("#")
                or nxt.startswith(">")
                or nxt.startswith("```")
                or nxt.strip().startswith("|")
                or re.match(r"^[-*]\s+", nxt)
                or re.match(r"^\d+\.\s+", nxt)
                or re.fullmatch(r"-{3,}", nxt.strip())
            ):
                break
            para_parts.append(nxt.strip())
            i += 1

        p = doc.add_paragraph()
        set_paragraph_spacing(p, before=2, after=8)
        add_inline_runs(p, " ".join(para_parts))

    flush_table()
    doc.save(DOCX_PATH)
    print(f"Wrote: {DOCX_PATH}")


if __name__ == "__main__":
    convert()
