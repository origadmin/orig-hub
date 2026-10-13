#!/usr/bin/env python3
"""BUG-304 · 文件域归集不变量 —— 引擎侧运行时验收（活栈）。

判据（对照 docs/bugs/BUG-304.md 出口判据，含 2026-10-14 修订）：
  1. 未归档（三表零认领）里**不存在**「无理由」的 video/photo 条目 ——
     每一条都必须有据可查：要么带墓碑（用户显式摘除，BUG-126），
     要么是非可分集 kind（文档/音频，`trg_media_episode_media_only`
     决定它们永远挂不上剧集，它们的家是文件域分类墙）。
  2. 「三表零认领」谓词的牙：只被 `media_episode_image` / `media_episode_source`
     认领的条目**不得**出现在 `?unassigned=true` 里（BUG-296 根因③）。
  3. `hasBytes=true` 过滤的牙：不过滤时列表里确实有无字节条目。
  4. 条目记录不减少：`media_item` 行数 >= 2026-10-14 重启前基线 532，
     总登记大小不降。

用法：python scripts/verify_bug304_engine_runtime.py
（需 dev 栈在跑；只读，不写任何数据。）
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.request

TG = os.environ.get("VERIFY_TG_BASE", "http://127.0.0.1:19787")
DB = os.path.expandvars(r"%APPDATA%/com.origadmin.orighub/tg/store.db")
# 2026-10-14 重启前（只读实测）基线：BUG-304 改动只增剧集/分集，不动条目与字节。
BASELINE_ITEMS = 532
BASELINE_SUM_SIZE = 31674673440

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures += 1


def api(path: str) -> dict:
    with urllib.request.urlopen(TG + path, timeout=10) as r:
        return json.loads(r.read())


def ro_db() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def main() -> int:
    # ── 判据 1：未归档条目必须条条有据 ──
    un = api("/api/media/items?unassigned=true&limit=500")
    items = un.get("items", [])
    conn = ro_db()
    reasons = []
    for it in items:
        tomb = conn.execute(
            "SELECT COUNT(*) FROM media_episode_removed WHERE item_id = ?", (it["id"],)
        ).fetchone()[0]
        if tomb:
            reasons.append((it["id"], it["kind"], "tombstone"))
        elif it["kind"] not in ("video", "photo"):
            reasons.append((it["id"], it["kind"], "non-episodic-kind"))
        else:
            reasons.append((it["id"], it["kind"], "NO-REASON"))
    no_reason = [r for r in reasons if r[2] == "NO-REASON"]
    check(
        "判据1 未归档 video/photo 条目条条有据（墓碑或用户摘除）",
        len(no_reason) == 0,
        f"unassigned={un.get('total')}；有据 {len(reasons) - len(no_reason)} 条，无理由 {len(no_reason)} 条 {no_reason[:5]}",
    )

    # ── 判据 2：三表谓词的牙（挂图/备用源认领不得误报） ──
    claimed_elsewhere = conn.execute(
        "SELECT i.id FROM media_item i \
         WHERE i.id NOT IN (SELECT item_id FROM media_episode) \
           AND (i.id IN (SELECT item_id FROM media_episode_image) \
                OR i.id IN (SELECT item_id FROM media_episode_source)) \
         ORDER BY i.id LIMIT 5"
    ).fetchall()
    un_ids = {it["id"] for it in items}
    leaked = [cid[0] for cid in claimed_elsewhere if cid[0] in un_ids]
    check(
        "判据2 挂图/备用源认领的条目不出现于 unassigned（三表谓词）",
        len(leaked) == 0,
        f"抽样 {len(claimed_elsewhere)} 条仅被他表认领，泄漏 {leaked}",
    )

    # ── 判据 3：hasBytes 过滤的牙 ──
    for kind in ("video", "photo"):
        plain = api(f"/api/media/items?kind={kind}&limit=500")
        filtered = api(f"/api/media/items?kind={kind}&hasBytes=true&limit=500")
        plain_missing = [
            it["id"]
            for it in plain.get("items", [])
            if it.get("bytesPresence") != "present"
        ]
        filt_missing = [
            it["id"]
            for it in filtered.get("items", [])
            if it.get("bytesPresence") != "present"
        ]
        check(
            f"判据3（牙）{kind} 不过滤时确有无字节条目",
            len(plain_missing) > 0,
            f"plain {len(plain_missing)}/{plain.get('total')}",
        )
        check(
            f"判据3 {kind} hasBytes=true 时无字节条目为 0",
            len(filt_missing) == 0,
            f"filtered {len(filt_missing)}/{filtered.get('total')}",
        )

    # ── 判据 4：条目与字节不减少 ──
    n_items, sum_size = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM media_item"
    ).fetchone()
    n_series = conn.execute("SELECT COUNT(*) FROM media_series").fetchone()[0]
    n_eps = conn.execute("SELECT COUNT(*) FROM media_episode").fetchone()[0]
    check(
        "判据4 条目记录不减少",
        n_items >= BASELINE_ITEMS,
        f"media_item={n_items}（基线 {BASELINE_ITEMS}）",
    )
    check(
        "判据4 总登记大小不降",
        sum_size >= BASELINE_SUM_SIZE,
        f"sum_size={sum_size}（基线 {BASELINE_SUM_SIZE}）",
    )
    print(
        f"INFO 当前：series={n_series} episodes={n_eps}"
        f"（重启前基线 series=79 episodes=285；归集只增不减）"
    )

    # ── 附加：SeriesView.hasBytes 契约在场 ──
    # 注意响应包裹是 `{items: [...]}`（listSeries 同款），不是 `{series: ...}`。
    series = api("/api/media/series?limit=500").get("items", [])
    with_field = sum(1 for s in series if "hasBytes" in s)
    false_cnt = sum(1 for s in series if s.get("hasBytes") is False)
    # 新旧谓词的分叉样本：封面无字节但**正片全在**—— 旧口径（coverHasBytes）会把
    # 它们误标「未缓存」并（在 BUG-254 时代）踢出可见性；新口径按「有没有任何内容」判。
    diverge = sum(
        1 for s in series if s.get("coverHasBytes") is False and s.get("hasBytes") is True
    )
    check(
        "契约 SeriesView.hasBytes 已下发",
        with_field == len(series),
        f"{with_field}/{len(series)}",
    )
    check(
        "契约（牙）存在 hasBytes=false 的剧集（证明前端过滤有活干）",
        false_cnt > 0,
        f"hasBytes=false: {false_cnt}",
    )
    check(
        "契约（牙）存在「封面无字节但剧集有内容」的剧集（新旧谓词分叉样本）",
        diverge > 0,
        f"coverHasBytes=false && hasBytes=true: {diverge}",
    )
    conn.close()

    print(f"\n{'ALL PASS' if failures == 0 else str(failures) + ' FAILURE(S)'} — BUG-304 引擎侧")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
