# -*- coding: utf-8 -*-
"""Tiny SVG diagram helper for 架构v1.md figures."""
from html import escape

FONT = "'Microsoft YaHei','Noto Sans CJK SC','Segoe UI',sans-serif"
INK = "#0f172a"
MUTED = "#475569"
LINE = "#334155"


def uw(s):
    w = 0.0
    for ch in s:
        w += 0.55 if ord(ch) < 128 else 1.0
    return w


def wrap(s, size, maxpx):
    limit = maxpx / (size * 1.02)
    out = []
    for para in str(s).split("\n"):
        if not para:
            out.append("")
            continue
        line = ""
        for ch in para:
            if uw(line + ch) > limit and line:
                out.append(line)
                line = ch
            else:
                line += ch
        out.append(line)
    return out


class D:
    def __init__(self, w, h, title=None):
        self.w, self.h = w, h
        self.parts = []
        if title:
            self.text(40, 46, title, 22, weight="700", color=INK)
            self.text(40, 72, "MetaInfer Research Lab v0.11.0 · 以当前工作树为准", 12, color="#64748b")

    # ---------- primitives ----------
    def text(self, x, y, s, size=12, color=INK, weight="400", anchor="start", opacity=1):
        self.parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{size}" '
            f'fill="{color}" font-weight="{weight}" text-anchor="{anchor}" opacity="{opacity}">{escape(str(s))}</text>'
        )

    def mtext(self, x, y, s, size=12, color=INK, weight="400", maxpx=None, lh=1.45, anchor="start"):
        maxpx = maxpx or 10_000
        lines = wrap(s, size, maxpx)
        for i, ln in enumerate(lines):
            self.text(x, y + i * size * lh, ln, size, color, weight, anchor)

    def zone(self, x, y, w, h, label=None, fill="#f8fafc", stroke="#cbd5e1", dash="6 5", label_color="#64748b"):
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{fill}" stroke="{stroke}" '
            f'stroke-width="1.4" {"stroke-dasharray=\"" + dash + "\"" if dash else ""}/>'
        )
        if label:
            self.parts.append(
                f'<text x="{x + 18}" y="{y + 26}" font-family="{FONT}" font-size="13" fill="{label_color}" '
                f'font-weight="700" letter-spacing="0.5">{escape(label)}</text>'
            )

    def box(self, x, y, w, h, title, lines=(), fill="#ffffff", stroke="#94a3b8", tcolor=INK,
            bcolor=MUTED, tsize=15, bsize=12, rx=10, sw=1.6, align="start", pad=16):
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'
        )
        tx = x + pad if align == "start" else x + w / 2
        self.text(tx, y + 27, title, tsize, tcolor, "700", "start" if align == "start" else "middle")
        cy = y + 27 + tsize + 8
        for ln in lines:
            for sub in wrap(ln, bsize, w - 2 * pad):
                self.text(tx, cy, sub, bsize, bcolor, "400", "start" if align == "start" else "middle")
                cy += bsize * 1.42
        return y + h

    def pill(self, x, y, w, h, label, fill="#e2e8f0", color="#0f172a", size=12, stroke="none"):
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h/2}" fill="{fill}" stroke="{stroke}"/>')
        self.text(x + w / 2, y + h / 2 + size * 0.36, label, size, color, "700", "middle")

    def badge(self, x, y, n, color="#dc2626", r=13):
        self.parts.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{color}" stroke="#ffffff" stroke-width="2.5"/>')
        self.text(x, y + 4.6, str(n), 13, "#ffffff", "700", "middle")

    def label(self, x, y, s, size=11.5, color=MUTED, anchor="middle", weight="600", bg=True):
        w = uw(s) * size * 1.02 + 10
        h = size + 8
        bx = x - w / 2 if anchor == "middle" else (x if anchor == "start" else x - w)
        if bg:
            self.parts.append(
                f'<rect x="{bx:.1f}" y="{y - size - 1:.1f}" width="{w:.1f}" height="{h}" rx="4" fill="#ffffff" opacity="0.93"/>'
            )
        self.text(x, y, s, size, color, weight, anchor)

    def arrow(self, pts, n=None, color=LINE, dashed=False, badge_color="#dc2626", note=None,
              note_at=None, note_anchor="middle", note_dy=-10, sw=2.0, curve=0, head=True, badge_at=None):
        d = f"M {pts[0][0]:.1f} {pts[0][1]:.1f}"
        for i in range(1, len(pts)):
            x0, y0 = pts[i - 1]
            x1, y1 = pts[i]
            if curve and i == len(pts) - 1:
                d += f" Q {(x0 + x1) / 2:.1f} {(y0 + y1) / 2 + curve:.1f} {x1:.1f} {y1:.1f}"
            else:
                d += f" L {x1:.1f} {y1:.1f}"
        dash = ' stroke-dasharray="8 6"' if dashed else ""
        mk = ' marker-end="url(#ah)"' if head else ""
        self.parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{dash}{mk}/>')
        if n is not None:
            bx, by = badge_at if badge_at else (note_at if note_at else pts[len(pts) // 2])
            self.badge(bx, by, n, badge_color)
        if note:
            bx, by = note_at if note_at else pts[len(pts) // 2]
            if note_anchor == "middle":
                self.label(bx, by + note_dy, note)
            else:
                self.label(bx, by + note_dy, note, anchor=note_anchor)

    def note(self, x, y, w, s, size=11.5, fill="#fffbeb", stroke="#f59e0b", color="#78350f", title=None):
        lines = wrap(s, size, w - 24)
        h = 12 + len(lines) * size * 1.45 + (22 if title else 0)
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>')
        cy = y + 18
        if title:
            self.text(x + 12, cy, title, 12.5, color, "700")
            cy += 20
        for ln in lines:
            self.text(x + 12, cy, ln, size, color)
            cy += size * 1.45
        return h

    def save(self, path):
        defs = (
            '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" '
            'orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>'
        )
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
            f'viewBox="0 0 {self.w} {self.h}">{defs}'
            f'<rect width="{self.w}" height="{self.h}" fill="#ffffff"/>'
            + "".join(self.parts)
            + "</svg>"
        )
        with open(path, "w", encoding="utf-8") as f:
            f.write(svg)
        print("wrote", path, self.w, self.h)
