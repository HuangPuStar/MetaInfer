"""Regression guard for the ``readOnly`` scope bug in ``dkao-detail.js``.

Every panel in the DKAO detail view reads its embedding context from a
``ctx = { taskId, stateDir, readOnly }`` object.  A component that referenced a
bare ``readOnly`` instead of ``ctx.readOnly`` compiled fine, shipped fine, and
passed every Python test — the existing contract tests only asserted the
substring ``"readOnly" in src`` — but it threw at **render** time:

    Uncaught ReferenceError: readOnly is not defined

``SkillLibrary`` was the victim: clicking "View skill library" never inserted
the panel and never even issued the ``GET /skills`` request, because the crash
happened while building the template.  The bug is invisible to review by
substring and invisible to the browser until the button is clicked, so it is
pinned here: ``readOnly`` may only appear in this file as a property of ``ctx``
or as a local declaration.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Tuple

import pytest

_TASK_DIR = Path(__file__).resolve().parents[1]
_STATIC = _TASK_DIR / "static" / "dkao-detail.js"

# A bare ``readOnly``: not preceded by a member access (``ctx.readOnly``) and
# not part of a longer identifier.
_BARE = re.compile(r"(?<![.\w$])readOnly\b")
_DECLARED = re.compile(r"\b(?:const|let|var)\s+readOnly\b")
_TOP_LEVEL_FN = re.compile(
    r"^(?:export\s+)?(?:default\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{", re.M
)


def _strip_comments(src: str) -> str:
    """Blank out comments while preserving every line number."""
    out = []
    i, n, in_line, in_block = 0, len(src), False, False
    while i < n:
        ch = src[i]
        if in_line:
            if ch == "\n":
                in_line = False
                out.append(ch)
            else:
                out.append(" ")
            i += 1
            continue
        if in_block:
            if src.startswith("*/", i):
                in_block = False
                out.append("  ")
                i += 2
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
        if src.startswith("//", i):
            in_line = True
            out.append("  ")
            i += 2
            continue
        if src.startswith("/*", i):
            in_block = True
            out.append("  ")
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _body_of(src: str, open_brace: int) -> str:
    depth = 0
    for j in range(open_brace, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[open_brace : j + 1]
    raise AssertionError("unbalanced braces in the JS source")


def _free_readonly(src: str) -> List[Tuple[str, int]]:
    """Return ``(function_name, line_number)`` for every bare ``readOnly``
    used inside a top-level function that does not declare it itself."""
    clean = _strip_comments(src)
    findings: List[Tuple[str, int]] = []
    for match in _TOP_LEVEL_FN.finditer(clean):
        name, params = match.group(1), match.group(2)
        body = _body_of(clean, match.end() - 1)
        body_start = clean.count("\n", 0, match.end() - 1)
        if _DECLARED.search(body) or re.search(r"\breadOnly\b", params):
            continue
        for hit in _BARE.finditer(body):
            tail = body[hit.end() :].lstrip()
            if tail.startswith(":"):  # object-literal key, e.g. `readOnly: x`
                continue
            line = body_start + body.count("\n", 0, hit.start()) + 1
            findings.append((name, line))
    return findings


# --------------------------------------------------------------------------- #
# The detector itself: it must flag exactly the shape that broke the page.
# --------------------------------------------------------------------------- #
_BUGGY = """\
function SkillLibrary({ ctx, onClose }) {
  const [busy, setBusy] = useState("");
  return html`
    ${readOnly ? html`<div class="task-banner">read only</div>` : null}
  `;
}
"""

_FIXED = _BUGGY.replace("${readOnly ?", "${ctx.readOnly ?")

# A component that declares its own `readOnly` (like DcuKernelAutoOptDetail)
# and an object literal that merely carries the key (like ctxOf) are both fine.
_LEGITIMATE = """\
function ctxOf(props) {
  return { taskId: props.taskId, readOnly: Boolean(props.readOnly) };
}

function Detail(props) {
  const readOnly = ctxOf(props).readOnly;
  return html`${readOnly ? html`<p>ro</p>` : null}`;
}
"""


def test_detector_flags_the_regression_it_was_written_for():
    assert _free_readonly(_BUGGY) == [("SkillLibrary", 4)]


def test_detector_accepts_qualified_and_declared_uses():
    assert _free_readonly(_FIXED) == []
    assert _free_readonly(_LEGITIMATE) == []


# --------------------------------------------------------------------------- #
# The real file.
# --------------------------------------------------------------------------- #
def test_static_file_exists():
    assert _STATIC.is_file(), f"missing static view: {_STATIC}"


def test_dkao_detail_never_reads_readonly_off_the_global_scope():
    findings = _free_readonly(_STATIC.read_text())
    assert not findings, (
        "bare `readOnly` (expected `ctx.readOnly`) in "
        + ", ".join(f"{name}() line {line}" for name, line in findings)
        + " -- this throws ReferenceError at render time and the panel "
        "silently never appears"
    )


def test_skill_library_is_reachable_and_gated_on_ctx():
    src = _STATIC.read_text()
    assert "View skill library" in src, "the skill panel lost its entry button"
    assert "${showSkills ? html`" in src, "the skill panel is no longer mounted"
    # The panel is the component that regressed; keep its ctx usage explicit.
    start = src.index("function SkillLibrary(")
    body = _body_of(_strip_comments(src), src.index(") {", start) + 2)
    assert "ctx.readOnly" in body, "SkillLibrary must gate writes on ctx.readOnly"
