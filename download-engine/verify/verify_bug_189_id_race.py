#!/usr/bin/env python3
"""Isolated-instance harness for the BUG-189 id race (`create_series` / `create_tag`).

WHAT IT DOES
------------
Spawns its OWN `orig-tg` on a free, non-production port, backed by a throwaway
temp database, then fires N-way concurrent writes and checks that **every id the
server returns maps to the row the caller actually created**:

  * `POST /api/media/series` -> `{"id": N}` must equal the id of the series row
    whose title is the caller's payload (titles are unique per call).
  * `POST /api/media/tags`   -> `{"id": N}` must equal the id of the tag row
    whose name is the caller's payload (names are unique per call).

Both routes used to do `INSERT ...` then a *separate* `SELECT last_insert_rowid()`
on one shared connection; `last_insert_rowid()` is connection-level and
table-agnostic, so concurrent requests interleave between the two awaits and the
returned id can belong to another request (or another table). This harness makes
that observable (or proves it is gone).

RAW NUMBERS, NOT A VERDICT
--------------------------
It prints a pairing table (caller title, returned id, actual id, match) and a
mismatch count per round. Exit code: 0 = zero mismatches; 1 = at least one
mismatch (the defect is present); 2 = environment/channel problem (binary
missing, port busy, server never became healthy, listener PID mismatch).

SAFETY (never touch the real library)
-------------------------------------
  * Refuses ports 9876 / 9877 (repo defaults) and 19786 / 19787 (this session's
    live services) — pass `--port` only for a free isolated port.
  * Never accepts a caller-supplied DB: it always creates its own throwaway temp
    DB, and hard-asserts that path is outside `%APPDATA%/com.origadmin.orighub`
    (the real library), so the real data can never be opened or written.
  * Default DB is a fresh `tempfile.mkdtemp()` dir, deleted on every exit path.
  * Server runs with `ORIG_TG_OFFLINE=1` (no MTProto), so the NON-mock production
    binary serves the local media library over the exact production code path.
  * After spawn it verifies the process listening on the port is the one it
    spawned (guards against silently measuring someone else's instance).

USAGE
-----
    cd download-engine
    python verify/verify_bug_189_id_race.py --binary target/release/orig-tg.exe
    # pre-fix binary (non-vacuity proof): needs --allow-prefix, expect exit 1
    python verify/verify_bug_189_id_race.py --binary /path/to/pre-fix.exe \
        --allow-prefix --rounds 5 --n 8

STALE-BINARY GATE
-----------------
The harness computes the sha256 of the binary under test. If it equals the
recorded PRE-FIX hash it REFUSES to run (exit 2) unless `--allow-prefix` is
given, so a green result can never come from the un-fixed binary.

OPTIONS
-------
    --binary PATH   orig-tg executable (default target/release/orig-tg.exe)
    --port N        isolated port (default: auto-pick a free port >= 19801)
    --rounds N      concurrency rounds per endpoint (default 5)
    --n N           concurrent callers per round (default 8)
    --label NAME    label for the run
    --out PATH      optional JSON artifact (default: none; refuses repo paths)
    --keep          keep the temp dir (debugging)
    --allow-prefix  permit the known PRE-FIX binary (non-vacuity proof only)
"""

import argparse
import atexit
import concurrent.futures
import hashlib
import json
import os
import random
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# Ports we must never bind: repo-default prod (9876 daemon / 9877 orig-tg) and
# this session's live services (19786 daemon / 19787 orig-tg).
FORBIDDEN_PORTS = {9876, 9877, 19786, 19787}

# Real-library directory we must never point --db at.
REAL_LIB_MARKER = os.path.join("com.origadmin.orighub")

# Auto-port search range for the isolated instance.
PORT_SEARCH_START = 19801
PORT_SEARCH_END = 19900

# sha256 of the PRE-FIX release binary, snapshotted before BUG-189 was fixed.
# A binary with this hash can only reproduce the OLD behaviour, so the harness
# REFUSES to interpret a run against it (exit 2) unless the caller explicitly
# opts in with --allow-prefix for a deliberate non-vacuity proof. This closes the
# "green run against a stale binary" trap: a defect must never survive a fix.
PRE_FIX_SHA256 = "d732bcfa253ea085ff4305e835b46977454350f6ff80589b38610cbe21f3e6f4"

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def log(msg):
    print(msg, flush=True)


def sha256_file(path):
    """Streaming sha256 of a file (hex)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def http_json(method, url, body=None, timeout=10):
    """Loopback JSON request -> (status, json|None, raw_text). status 0 = transport error."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, (json.loads(raw) if raw else None), raw
            except json.JSONDecodeError:
                return r.status, None, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        try:
            return e.code, (json.loads(raw) if raw else None), raw
        except json.JSONDecodeError:
            return e.code, None, raw
    except Exception as e:  # noqa: BLE001
        return 0, None, str(e)


def free_port():
    """Find a free TCP port in [PORT_SEARCH_START, PORT_SEARCH_END].

    The scan order is randomized: a deterministic lowest-first scan makes two
    harness instances started at the same instant both pick 19801 (a TOCTOU race
    between bind-test and the child's own bind). Randomizing makes that collision
    unlikely; the listener-PID check in `Instance.verify_listener` remains the
    authoritative backstop (it aborts with exit 2 rather than measuring a peer).
    """
    candidates = [
        p
        for p in range(PORT_SEARCH_START, PORT_SEARCH_END + 1)
        if p not in FORBIDDEN_PORTS
    ]
    random.shuffle(candidates)
    for p in candidates:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    raise RuntimeError("no free port in search range")


def listener_pid(port):
    """PID listening on 127.0.0.1:<port>, or None (Windows netstat).

    netstat's text is emitted in the local OEM codepage, so decode as bytes with
    errors='replace' rather than text=True (which forces UTF-8 and can raise).
    """
    try:
        proc = subprocess.run(["netstat", "-ano"], capture_output=True, timeout=10)
    except Exception:  # noqa: BLE001
        return None
    raw = proc.stdout or b""
    out = raw.decode("utf-8", "replace")
    if "\ufffd" in out:  # fall back to the local ANSI codepage on mojibake
        try:
            out = raw.decode("mbcs", "replace")
        except Exception:  # noqa: BLE001
            pass
    pat = re.compile(r"TCP\s+127\.0\.0\.1:%d\s+\S+\s+LISTENING\s+(\d+)" % port)
    for line in out.splitlines():
        m = pat.search(line)
        if m:
            return int(m.group(1))
    return None


def wait_health(base, timeout_s=40):
    """Poll /health until 200. Returns True on success."""
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        st, _j, raw = http_json("GET", base + "/health", timeout=3)
        last = f"http={st}"
        if st == 200:
            return True
        time.sleep(0.25)
    log(f"[harness] /health never became ready ({last})")
    return False


class Instance:
    """Owns one isolated orig-tg process + its temp dir; tears down on every path."""

    def __init__(self, binary, port, keep):
        self.binary = binary
        self.port = port
        self.keep = keep
        self.proc = None
        self.tmpdir = None
        self.base = f"http://127.0.0.1:{port}"
        self._torn = False

    def start(self):
        if not os.path.isfile(self.binary):
            raise RuntimeError(f"binary not found: {self.binary}")
        self.tmpdir = tempfile.mkdtemp(prefix="orighub-bug189-")
        db_path = os.path.join(self.tmpdir, "store.db")
        sess_path = os.path.join(self.tmpdir, "session")
        # Hard guard: never let the isolated instance open the real library.
        if REAL_LIB_MARKER.lower() in os.path.abspath(db_path).lower():
            raise RuntimeError(f"refusing to use a DB path inside the real library: {db_path}")
        env = dict(os.environ)
        env.update(
            {
                "ORIG_TG_OFFLINE": "1",  # no MTProto; local media library still served
                "ORIG_TG_PORT": str(self.port),
                "ORIG_TG_DB": db_path,
                "ORIG_TG_SESSION": sess_path,
                # keep the monitor loop from doing anything TG-ish
                "ORIG_TG_MONITOR_INTERVAL": "3600",
            }
        )
        log_path = os.path.join(self.tmpdir, "server.log")
        self._logf = open(log_path, "wb")
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.proc = subprocess.Popen(
            [self.binary],
            env=env,
            stdout=self._logf,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
        log(
            f"[harness] spawned pid={self.proc.pid} port={self.port} "
            f"db={db_path} bin={self.binary}"
        )

    def verify_listener(self):
        """Ensure the process listening on our port is the one we spawned."""
        if self.proc.poll() is not None:
            return False, f"spawned process exited early (rc={self.proc.returncode})"
        pid = listener_pid(self.port)
        if pid is None:
            return False, "no LISTENING socket on our port"
        if pid != self.proc.pid:
            return False, f"port owned by pid={pid}, not our pid={self.proc.pid}"
        return True, f"listener pid={pid} == spawned pid={self.proc.pid}"

    def stop(self):
        if self._torn:
            return
        self._torn = True
        if self.proc is not None and self.proc.poll() is None:
            try:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(self.proc.pid)],
                        capture_output=True,
                        timeout=15,
                    )
                else:
                    self.proc.terminate()
            except Exception:  # noqa: BLE001
                pass
            try:
                self.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                pass
        try:
            self._logf.close()
        except Exception:  # noqa: BLE001
            pass
        # dump a tail of the server log for diagnostics
        try:
            with open(os.path.join(self.tmpdir, "server.log"), "r", encoding="utf-8", errors="replace") as f:
                tail = f.read().strip().splitlines()[-6:]
            if tail:
                log("[harness] server.log tail:")
                for ln in tail:
                    log("    " + ln)
        except Exception:  # noqa: BLE001
            pass
        if self.tmpdir and not self.keep:
            shutil.rmtree(self.tmpdir, ignore_errors=True)
        elif self.tmpdir:
            log(f"[harness] kept temp dir: {self.tmpdir}")


# ─────────────────────────── concurrency checks ───────────────────────────


def map_title_to_id(base, kind):
    """title/name -> id from the listing endpoint."""
    path = "/api/media/series" if kind == "series" else "/api/media/tags"
    st, j, _raw = http_json("GET", base + path)
    if st != 200 or not isinstance(j, dict):
        return {}
    items = j.get("items", [])
    out = {}
    for it in items:
        key = it.get("title") if kind == "series" else it.get("name")
        if key is not None and "id" in it:
            out[key] = it["id"]
    return out


def one_create(base, kind, payload):
    """POST a single unique row; return (payload_key, returned_id, status)."""
    path = "/api/media/series" if kind == "series" else "/api/media/tags"
    body = payload["body"]
    st, j, _raw = http_json("POST", base + path, body)
    rid = j.get("id") if isinstance(j, dict) else None
    return payload["key"], rid, st


def run_round(base, kind, round_idx, n, ts):
    """Fire n concurrent unique creates; compare returned id vs actual row id."""
    payloads = []
    for i in range(n):
        key = f"ZZ-BUG189-{kind.upper()}-{ts}-r{round_idx}-c{i}"
        if kind == "series":
            body = {"title": key, "kind": "series"}
        else:
            body = {"name": key}
        payloads.append({"key": key, "body": body})

    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
        futs = [ex.submit(one_create, base, kind, p) for p in payloads]
        for f in concurrent.futures.as_completed(futs):
            rows.append(f.result())

    # small settle, then resolve actual ids by unique key
    actual = {}
    for _ in range(20):
        actual = map_title_to_id(base, kind)
        if all(p["key"] in actual for p in payloads):
            break
        time.sleep(0.1)

    table = []
    for (key, rid, st) in sorted(rows, key=lambda r: r[0]):
        aid = actual.get(key)
        match = (st == 200 and rid is not None and aid is not None and rid == aid)
        table.append(
            {"key": key, "returned": rid, "actual": aid, "status": st, "match": match}
        )
    return table


def main():
    ap = argparse.ArgumentParser(description="BUG-189 isolated id-race harness")
    ap.add_argument(
        "--binary",
        default=os.path.join(REPO_ROOT, "download-engine", "target", "release", "orig-tg.exe"),
    )
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--label", default="run")
    ap.add_argument("--out", default=None)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument(
        "--allow-prefix",
        action="store_true",
        help="permit running the known PRE-FIX binary (non-vacuity proof only)",
    )
    args = ap.parse_args()

    # ── safety gates ───────────────────────────────────────────────────
    if args.port in FORBIDDEN_PORTS:
        log(f"[harness] REFUSED: port {args.port} is a production/live port")
        sys.exit(2)
    port = args.port or free_port()

    # ── stale-binary gate (the trap that lets a defect survive a fix) ───
    if not os.path.isfile(args.binary):
        log(f"[harness] ENV: binary not found: {args.binary}. Aborting (exit 2).")
        sys.exit(2)
    bin_sha = sha256_file(args.binary)
    log(f"[harness] binary sha256 = {bin_sha}")
    if bin_sha == PRE_FIX_SHA256 and not args.allow_prefix:
        log("[harness] **********************************************************")
        log("[harness] REFUSED: binary sha256 == PRE-FIX build (d732bcfa...).")
        log("[harness] A run here only re-tests the OLD defect; a PASS would be a")
        log("[harness] false green. Rebuild the fix first (or, for a deliberate")
        log("[harness] non-vacuity proof, pass --allow-prefix). Aborting (exit 2).")
        log("[harness] **********************************************************")
        sys.exit(2)
    if bin_sha == PRE_FIX_SHA256:
        log("[harness] WARNING: --allow-prefix set -> running the PRE-FIX binary on")
        log("[harness] purpose; results describe the OLD behaviour, not the fix.")

    log(f"[harness] label={args.label} binary={args.binary}")
    log(f"[harness] rounds={args.rounds} n={args.n} port={port}")

    inst = Instance(args.binary, port, args.keep)
    atexit.register(inst.stop)

    def _sig(signum, _frame):
        inst.stop()
        sys.exit(130)

    signal.signal(signal.SIGINT, _sig)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _sig)

    rc = 2
    artifact = {
        "label": args.label,
        "binary": args.binary,
        "binary_sha256": bin_sha,
        "rounds": args.rounds,
        "n": args.n,
    }
    try:
        try:
            inst.start()
        except Exception as e:  # noqa: BLE001
            # Missing binary / spawn failure is an environment problem, not a
            # defect signal -> exit 2 (never 1, which would mean "mismatch seen").
            log(f"[harness] ENV: could not spawn server: {e}. Aborting (exit 2).")
            return 2
        if not wait_health(inst.base, timeout_s=40):
            log("[harness] ENV: server did not become healthy. Aborting (exit 2).")
            return 2
        ok, why = inst.verify_listener()
        log(f"[harness] listener check: {why}")
        if not ok:
            log("[harness] ENV: refusing to measure an instance we do not own. Aborting (exit 2).")
            return 2

        # sanity: media endpoints reachable
        st, _j, _r = http_json("GET", inst.base + "/api/media/series")
        if st != 200:
            log(f"[harness] ENV: GET /api/media/series -> {st}. Aborting (exit 2).")
            return 2

        ts = int(time.time() * 1000)
        total = 0
        mismatches = 0
        all_tables = {}
        for kind in ("series", "tags"):
            all_tables[kind] = []
            for r in range(args.rounds):
                table = run_round(inst.base, kind, r, args.n, ts)
                all_tables[kind].append(table)
                m = sum(0 if row["match"] else 1 for row in table)
                total += len(table)
                mismatches += m
                log(f"--- {kind} round {r}: {len(table)-m}/{len(table)} matched, {m} mismatch ---")
                for row in table:
                    flag = "OK " if row["match"] else "BAD"
                    log(
                        f"    [{flag}] {row['key']}  returned={row['returned']} "
                        f"actual={row['actual']} status={row['status']}"
                    )
        artifact["total"] = total
        artifact["mismatches"] = mismatches
        artifact["tables"] = all_tables
        log(f"[harness] TOTAL rows={total} mismatches={mismatches}")
        rc = 0 if mismatches == 0 else 1
    finally:
        inst.stop()
        if args.out:
            outp = os.path.abspath(args.out)
            if outp.startswith(REPO_ROOT + os.sep):
                log(f"[harness] REFUSED to write artifact inside repo: {outp}")
            else:
                os.makedirs(os.path.dirname(outp), exist_ok=True)
                with open(outp, "w", encoding="utf-8") as f:
                    json.dump(artifact, f, indent=2)
                log(f"[harness] artifact -> {outp}")

    log(
        "[harness] RESULT: "
        + ("ALL MATCH (exit 0)" if rc == 0 else "MISMATCH PRESENT (exit 1)" if rc == 1 else "ENV (exit 2)")
    )
    return rc


if __name__ == "__main__":
    sys.exit(main())
