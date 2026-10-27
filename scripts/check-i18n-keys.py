#!/usr/bin/env python3
"""i18n key-parity gate.

Why this exists (BUG-431): `tg.backfillCancel` was defined in `en-US.json` only.
`t('tg.backfillCancel')` therefore rendered the **raw key string** in the Chinese
UI. Nothing failed -- no crash, no TS error, no test. A missing key is silent by
design (i18next-style fallbacks), so it can only be caught by comparing the key
sets of the shipped locales.

Checks, per locale:
  1. missing key      -> a key present in ANY locale is absent here (BLOCKING).
                         The baseline is the UNION of all locales, not one chosen
                         "reference" file: with a single reference, a key missing
                         from the reference itself shows up as an "extra" key in
                         the other locale and slips through as a warning. That is
                         exactly how BUG-431 survived (zh-CN lacked the key).
  2. placeholder drift-> same key, different `{placeholder}` set (BLOCKING;
                         a renamed placeholder renders `{date}` literally)
  3. empty value      -> value is empty/whitespace (BLOCKING)
  4. dangling reference (BUG-447) -> source code passes a key to `t()` (or holds
                         it in a key-literal map that `t()` consumes) that NO
                         locale defines. `t()` returns the raw key on a miss, so
                         the UI renders `media.card.delete` to the user. Checks
                         1-3 cannot catch this: they only compare locale files
                         with each other, so "perfectly aligned" and "referencing
                         keys that exist nowhere" are both green at once.

Usage:
    python scripts/check-i18n-keys.py [--quiet]

Exit code 0 = OK, 1 = violations. No network, no repo mutation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

LOCALES_DIR = Path(__file__).resolve().parent.parent / "tauri-shell" / "src" / "i18n" / "locales"
REFERENCE = "zh-CN.json"
PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")

# Keys whose `{...}` are NOT i18n placeholders but *documented template syntax*
# shown to the user verbatim. `orig-tg/src/organize.rs` accepts both the Chinese
# and the English variable names (`"剧名" | "series" | ...`), so each locale is
# correct in its own script and the placeholder sets legitimately differ.
# Keep this list explicit: it is the only sanctioned escape hatch, and every
# entry must cite the code that accepts both spellings.
LITERAL_BRACE_KEYS = {
    # organize.rs:173-197 — `剧名|series`, `季|season`, `集|episode`, ...
    "media.organize.varsHint",
    # The template itself is the string the user edits; `{season:02}` is template
    # syntax shown verbatim, and each locale documents its own variable spelling.
    "media.organize.templateDefault",
}

SRC_DIR = Path(__file__).resolve().parent.parent / "tauri-shell" / "src"
SRC_SUFFIXES = {".ts", ".tsx"}

# `t('a.b.c')` / t("a.b.c") / t(`a.b.c`) — static literal only. A template with
# `${}` is dynamic and cannot be verified statically; those are reported as WARN.
T_CALL_RE = re.compile(r"\bt\(\s*['\"`]([A-Za-z0-9_.\-]+)['\"`]")
# Any dotted string literal (key maps, helper tables, props) — narrowed below to
# literals whose first segment is a known i18n namespace, so CSS/URL-ish strings
# such as "bg.surface.2" or "com.origadmin.orighub" cannot produce false alarms.
DOTTED_LITERAL_RE = re.compile(r"['\"`]([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){1,})['\"`]")
DYNAMIC_T_RE = re.compile(r"\bt\(\s*`[^`]*\$\{")

# Files that legitimately talk about keys as data (the gate itself, the i18n
# runtime, dictionaries) — their literals are not UI references.
SCAN_EXCLUDE_PARTS = ("__tests__", "verify", "locales")

# A literal that ends with a dot is a *prefix* later concatenated with a runtime
# value (`t('category.' + c.category)`); it is a dynamic key by construction and
# cannot be resolved statically. Same for anything shaped like a file name.
FILE_EXT_RE = re.compile(r"\.(tsx?|jsx?|rs|json|md|cjs|mjs|py|html|css|toml|yaml|yml|sh)$")


def load(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:  # pragma: no cover - malformed input is fatal
        print(f"FAIL  {path.name}: invalid JSON — {exc}")
        raise SystemExit(1)
    if not isinstance(data, dict):
        print(f"FAIL  {path.name}: top level must be an object")
        raise SystemExit(1)
    return {k: v for k, v in data.items() if isinstance(v, str)}


def placeholders(value: str) -> set[str]:
    return set(PLACEHOLDER_RE.findall(value))


def scan_references(namespaces: set[str]) -> tuple[dict[str, list[str]], list[str]]:
    """Return ({key: [file:line, ...]}, [dynamic-call warnings]).

    Only literals whose first segment is an i18n namespace are considered, which
    is what keeps this check from flagging every dotted string in the codebase.
    """
    found: dict[str, list[str]] = {}
    dynamic: list[str] = []
    if not SRC_DIR.is_dir():
        return found, [f"src dir not found: {SRC_DIR}"]

    for path in sorted(SRC_DIR.rglob("*")):
        if path.suffix not in SRC_SUFFIXES or not path.is_file():
            continue
        rel = path.relative_to(SRC_DIR).as_posix()
        if any(part in SCAN_EXCLUDE_PARTS for part in rel.split("/")):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        for lineno, line in enumerate(lines, 1):
            # Comment lines mention keys such as `media.rs` or `nav.fmode` as
            # documentation; they are never passed to t(). Skipping lines whose
            # first non-space characters start a comment keeps those out without
            # needing a full JS parser.
            stripped = line.strip()
            if stripped.startswith(("//", "/*", "*")):
                continue
            for m in T_CALL_RE.finditer(line):
                key = m.group(1)
                # `t('category.' + c.category)` — a prefix concatenated with a
                # runtime value; dynamic by construction, not a dangling key.
                if key.endswith("."):
                    continue
                if key.split(".")[0] in namespaces or "." in key:
                    found.setdefault(key, []).append(f"{rel}:{lineno}")
            for m in DOTTED_LITERAL_RE.finditer(line):
                key = m.group(1)
                if key.endswith(".") or FILE_EXT_RE.search(key):
                    continue
                if key.split(".")[0] in namespaces:
                    entry = f"{rel}:{lineno}"
                    if entry not in found.setdefault(key, []):
                        found[key].append(entry)
            for m in DYNAMIC_T_RE.finditer(line):
                dynamic.append(f"{rel}:{lineno}: {line.strip()[:90]}")
    return found, dynamic


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not LOCALES_DIR.is_dir():
        print(f"FAIL  locales dir not found: {LOCALES_DIR}")
        return 1

    files = sorted(p for p in LOCALES_DIR.glob("*.json"))
    ref_path = LOCALES_DIR / REFERENCE
    if not ref_path.is_file():
        print(f"FAIL  reference locale missing: {ref_path}")
        return 1

    ref = load(ref_path)
    loaded = {p.name: load(p) for p in files}
    violations: list[str] = []

    # Baseline = union of every key any locale defines. A key that only one
    # locale knows about is a missing key in all the others -- never "extra".
    union: set[str] = set()
    for data in loaded.values():
        union |= set(data)

    for name, data in loaded.items():
        for key in sorted(union - set(data)):
            defined = sorted(n for n, d in loaded.items() if key in d)
            violations.append(
                f"{name}: missing key `{key}` (defined in {', '.join(defined)})"
            )
        for key in sorted(set(data)):
            if not data[key].strip():
                violations.append(f"{name}: empty value for `{key}`")

    # Placeholder parity is measured against the reference where both define it.
    for name, data in loaded.items():
        if name == REFERENCE:
            continue
        for key in sorted(set(ref) & set(data)):
            if key in LITERAL_BRACE_KEYS:
                continue
            want, got = placeholders(ref[key]), placeholders(data[key])
            if want != got:
                violations.append(
                    f"{name}: placeholder drift on `{key}` — "
                    f"{REFERENCE}{sorted(want)} vs {name}{sorted(got)}"
                )

    # ---- check 4 (BUG-447): every key the code hands to t() must exist ----
    namespaces = {k.split(".")[0] for k in union}
    refs, dynamic = scan_references(namespaces)
    dangling = {k: sites for k, sites in refs.items() if k not in union}
    for key in sorted(dangling):
        sites = ", ".join(dangling[key][:3])
        more = "" if len(dangling[key]) <= 3 else f" (+{len(dangling[key]) - 3} more)"
        violations.append(
            f"dangling i18n reference `{key}` — no locale defines it, "
            f"so t() renders the raw key. referenced at {sites}{more}"
        )
    if dynamic and not args.quiet:
        print(f"warn  {len(dynamic)} dynamic t(`...${{...}}`) call(s) — "
              f"not statically verifiable (first: {dynamic[0]})")

    if not args.quiet:
        for v in violations:
            print(f"FAIL  {v}")

    if violations:
        print(f"\ni18n gate: {len(violations)} violation(s) across "
              f"{len(files)} locale file(s) [{len(union)} distinct keys]")
        return 1

    print(f"OK - i18n keys aligned ({len(files)} locales, {len(union)} keys)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
