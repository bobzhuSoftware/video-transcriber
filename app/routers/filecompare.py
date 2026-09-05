"""Text file comparison — upload two text files and get an aligned line diff.

Supports optional JSON normalization (pretty-print before diffing) and
character-level inline highlighting inside changed lines.
"""
import difflib
import json
import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.core.auth import require_user
from app.core.db import User

router = APIRouter()

# Guard against pathological payloads that would produce a huge JSON response.
_MAX_BYTES = 5 * 1024 * 1024  # 5 MB per file
_MAX_ROWS = 20000
# Above this line length, fall back to cheap common prefix/suffix inline diff.
_INLINE_MAX_LEN = 2000
# Minimum similarity for two lines in a replace block to be paired (vs split).
_SIMILARITY = 0.3

_WS_RE = re.compile(r"\s+")


def _decode(data: bytes) -> str:
    """Decode bytes as text, trying common encodings before a lossy fallback."""
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _try_json(text: str):
    """Return the parsed object if text is valid JSON, else None."""
    try:
        return json.loads(text)
    except (ValueError, RecursionError):
        return None


def _key(line: str, ignore_ws: bool, ignore_case: bool) -> str:
    """Comparison key for a line, honouring the ignore-whitespace/case options."""
    key = line
    if ignore_ws:
        key = _WS_RE.sub(" ", key).strip()
    if ignore_case:
        key = key.lower()
    return key


def _similar(a: str, b: str) -> bool:
    """Whether two changed lines are alike enough to pair (inline) vs split."""
    if not a or not b:
        return False
    return difflib.SequenceMatcher(a=a, b=b).quick_ratio() >= _SIMILARITY


def _inline_segments(a: str, b: str) -> tuple[list[dict], list[dict]]:
    """Character-level diff of two lines → (left_segments, right_segments)."""
    if max(len(a), len(b)) > _INLINE_MAX_LEN:
        return _prefix_suffix_segments(a, b)
    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    left: list[dict] = []
    right: list[dict] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            left.append({"text": a[i1:i2], "changed": False})
            right.append({"text": b[j1:j2], "changed": False})
        elif tag == "delete":
            left.append({"text": a[i1:i2], "changed": True})
            right.append({"caret": True})  # mark where left-only text was removed
        elif tag == "insert":
            left.append({"caret": True})  # mark where right-only text was added
            right.append({"text": b[j1:j2], "changed": True})
        else:  # replace
            left.append({"text": a[i1:i2], "changed": True})
            right.append({"text": b[j1:j2], "changed": True})
    return left, right


def _prefix_suffix_segments(a: str, b: str) -> tuple[list[dict], list[dict]]:
    """Cheap inline diff for very long lines: common prefix + changed middle + suffix."""
    limit = min(len(a), len(b))
    pre = 0
    while pre < limit and a[pre] == b[pre]:
        pre += 1
    suf = 0
    while suf < limit - pre and a[-1 - suf] == b[-1 - suf]:
        suf += 1
    left: list[dict] = []
    right: list[dict] = []
    if pre:
        left.append({"text": a[:pre], "changed": False})
        right.append({"text": b[:pre], "changed": False})
    mid_a = a[pre:len(a) - suf]
    mid_b = b[pre:len(b) - suf]
    if mid_a:
        left.append({"text": mid_a, "changed": True})
    elif mid_b:
        left.append({"caret": True})  # right-only text added here
    if mid_b:
        right.append({"text": mid_b, "changed": True})
    elif mid_a:
        right.append({"caret": True})  # left-only text removed here
    if suf:
        left.append({"text": a[len(a) - suf:], "changed": False})
        right.append({"text": b[len(b) - suf:], "changed": False})
    return left, right


def _row_delete(line_no: int, text: str) -> dict:
    return {"type": "delete", "left_no": line_no, "left": text, "right_no": None, "right": None}


def _row_insert(line_no: int, text: str) -> dict:
    return {"type": "insert", "left_no": None, "left": None, "right_no": line_no, "right": text}


def _build_rows(
    left_lines: list[str],
    right_lines: list[str],
    left_keys: list[str],
    right_keys: list[str],
) -> list[dict]:
    """Align two line lists into side-by-side rows tagged equal/insert/delete/replace.

    The line-level alignment runs on the comparison keys (which may ignore
    whitespace/case), while the displayed text and inline diff use the originals.
    """
    rows: list[dict] = []
    matcher = difflib.SequenceMatcher(a=left_keys, b=right_keys, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                rows.append({
                    "type": "equal",
                    "left_no": i1 + offset + 1,
                    "left": left_lines[i1 + offset],
                    "right_no": j1 + offset + 1,
                    "right": right_lines[j1 + offset],
                })
        elif tag == "delete":
            for offset in range(i2 - i1):
                rows.append(_row_delete(i1 + offset + 1, left_lines[i1 + offset]))
        elif tag == "insert":
            for offset in range(j2 - j1):
                rows.append(_row_insert(j1 + offset + 1, right_lines[j1 + offset]))
        else:  # replace
            _emit_replace(rows, left_lines, right_lines, i1, i2, j1, j2)
    return rows


def _emit_replace(rows, left_lines, right_lines, i1, i2, j1, j2):
    """Pair similar lines within a replace block; split dissimilar ones apart."""
    left_count = i2 - i1
    right_count = j2 - j1
    paired = min(left_count, right_count)
    for offset in range(paired):
        left_text = left_lines[i1 + offset]
        right_text = right_lines[j1 + offset]
        if _similar(left_text, right_text):
            left_seg, right_seg = _inline_segments(left_text, right_text)
            rows.append({
                "type": "replace",
                "left_no": i1 + offset + 1,
                "left": left_text,
                "left_seg": left_seg,
                "right_no": j1 + offset + 1,
                "right": right_text,
                "right_seg": right_seg,
            })
        else:
            rows.append(_row_delete(i1 + offset + 1, left_text))
            rows.append(_row_insert(j1 + offset + 1, right_text))
    for offset in range(paired, left_count):
        rows.append(_row_delete(i1 + offset + 1, left_lines[i1 + offset]))
    for offset in range(paired, right_count):
        rows.append(_row_insert(j1 + offset + 1, right_lines[j1 + offset]))


@router.post("/api/compare/files")
async def compare_files(
    file1: UploadFile = File(...),
    file2: UploadFile = File(...),
    normalize_json: bool = Form(False),
    ignore_whitespace: bool = Form(False),
    ignore_case: bool = Form(False),
    user: User = Depends(require_user),
):
    """Compare two uploaded text files and return an aligned side-by-side line diff."""
    data1 = await file1.read()
    data2 = await file2.read()

    for data in (data1, data2):
        if len(data) > _MAX_BYTES:
            raise HTTPException(status_code=413, detail="文件过大，单个文件请控制在 5 MB 以内。")
        if b"\x00" in data:
            raise HTTPException(status_code=400, detail="检测到二进制文件，仅支持纯文本文件对比。")

    text1 = _decode(data1)
    text2 = _decode(data2)

    obj1 = _try_json(text1)
    obj2 = _try_json(text2)
    json_detected = obj1 is not None and obj2 is not None

    normalized = json_detected and normalize_json
    if normalized:
        text1 = json.dumps(obj1, indent=2, ensure_ascii=False)
        text2 = json.dumps(obj2, indent=2, ensure_ascii=False)

    left_lines = text1.splitlines()
    right_lines = text2.splitlines()
    left_keys = [_key(ln, ignore_whitespace, ignore_case) for ln in left_lines]
    right_keys = [_key(ln, ignore_whitespace, ignore_case) for ln in right_lines]

    rows = _build_rows(left_lines, right_lines, left_keys, right_keys)
    truncated = len(rows) > _MAX_ROWS
    if truncated:
        rows = rows[:_MAX_ROWS]

    added = sum(1 for r in rows if r["type"] == "insert")
    removed = sum(1 for r in rows if r["type"] == "delete")
    changed = sum(1 for r in rows if r["type"] == "replace")

    return {
        "file1": file1.filename,
        "file2": file2.filename,
        "rows": rows,
        "identical": added == 0 and removed == 0 and changed == 0,
        "summary": {"added": added, "removed": removed, "changed": changed},
        "truncated": truncated,
        "json_detected": json_detected,
        "normalized": normalized,
    }
