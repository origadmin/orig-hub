"""Verify the debug/offline TG environment is a clean "debug environment", not an error environment.

Asserts against a running orig-tg started in debug/offline mode
(`verify_shots/restart_tg.py`, which sets ORIG_TG_OFFLINE=1):

  - GET /api/tg/diag   -> 200, mode=="unavailable", reason mentions "offline debug mode"
  - GET /api/tg/session -> 200, available==False   (status endpoint, never 503)
  - GET /api/media/series -> 200                   (local library usable offline)

The point: a debug web session must not be flooded with red 503 errors. TG is
intentionally offline; that is a neutral state (rendered as a "调试模式" panel),
not a failure. Cross-machine: run while the debug orig-tg is up.

Exit code non-zero on any failure.
"""
import json
import sys
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:9877"
CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append((ok, name, detail))
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {name}" + (f" — {detail}" if detail else ""))


def get(path):
    try:
        with urllib.request.urlopen(BASE + path, timeout=5) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # noqa: BLE001
        return 0, None


def main():
    st, diag = get("/api/tg/diag")
    check("diag http=200", st == 200, f"http={st}")
    if diag:
        check("diag mode==unavailable", diag.get("mode") == "unavailable",
              f"mode={diag.get('mode')}")
        reason = diag.get("unavailable_reason") or ""
        check("diag reason mentions offline debug mode",
              "offline debug mode" in reason, reason)
        check("diag is not a 503 data failure", st != 503, f"http={st}")

    st, sess = get("/api/tg/session")
    check("session http=200", st == 200, f"http={st}")
    if sess:
        check("session available==false", sess.get("available") is False,
              f"available={sess.get('available')}")

    st, _ = get("/api/media/series")
    check("media library http=200 (usable offline)", st == 200, f"http={st}")

    failed = [c for c in CHECKS if not c[0]]
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
