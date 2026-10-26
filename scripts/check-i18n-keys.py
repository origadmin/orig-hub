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
}


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
