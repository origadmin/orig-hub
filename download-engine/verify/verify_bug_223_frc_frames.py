#!/usr/bin/env python3
"""BUG-223 服务端 FRC（非 1x 倍速）的**端到端帧数与时长判据**。

用途：用 ffmpeg 自身统计（`ffprobe -count_frames`）证明速度派生流真的是
「30fps CFR + 时长 = 源时长 / S」，而不是「看起来在动就行」。

## 为什么要有这个脚本

`routes.rs:3170 speed_video_filter` 产出 `setpts=(PTS-STARTPTS)/S,fps=30`；
仓库里原有的单测（routes.rs:4563）只断言这串**字符串**，没有任何一次真实编码，
因此「滤镜串写错一个字符」与「滤镜真的产出 30fps」在 CI 里长得一模一样。
BUG-223 的判据①要求 ffprobe 验证 `avg_frame_rate=30/1` 且时长 ≈ 源时长/S，
本脚本就是那条判据的可执行形态。

## 判据（可证伪，成对）

1. `avg_frame_rate == 30/1`（CFR 30fps，BUG-209 的 30fps 上限）；
2. 输出时长 ≈ 源时长 / S（容差 1 帧 = 1/30 s）；
3. 输出帧数 ≈ round(源时长 / S × 30)（容差 1 帧）；
4. **反向证伪**（`--falsify`）：把滤镜换成被否决的 `select=not(mod(n\,K))` 提案，
   同一套判据**必须失败**（1.5x 与 0.5x 档）。判据若对错误实现也绿，等于没有判据。

## 关于 `select=not(mod(n\,K))` 提案（已否决，留此存档）

提案：整数帧号取模抽帧，`K = round(源fps × S / 30)`，`setpts=N/30/TB`。
否决理由（本脚本 `--falsify` 给出实测）：
- `K` 只在「源fps × S / 30」恰为整数时精确（30fps 源的 2x/3x/4x 恰好命中）；
  1.25x(K=1.25)、1.5x(K=1.5)、25fps@2x(K=1.67) 都会被 round 抹掉 ⇒ 时长与速度直接偏。
- S < 1 需要**复制帧**（0.5x 要 2 倍帧），`select` 只能丢帧 ⇒ K=1 时慢放完全不生效。
- 需要先 ffprobe 探测源帧率；VFR 源没有单一 src_fps，K 无定义。
而 `fps=30` 天然吃分数比（1.5x 实测 200 帧 = 300×2/3，即 2-1-2-1 均匀抽帧）与 VFR。

## 运行

    python download-engine/verify/verify_bug_223_frc_frames.py            # 正向判据
    python download-engine/verify/verify_bug_223_frc_frames.py --falsify  # 反向证伪

ffmpeg / ffprobe 解析：`ORIG_FFMPEG_PATH` / `ORIG_FFPROBE_PATH`（显式）→
`%LOCALAPPDATA%/OrigHub/bin` → PATH。与 `routes.rs:3210 resolve_ffmpeg_path` 同口径。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

SPEEDS = [50, 75, 125, 150, 200, 300, 400]  # 0.5 / 0.75 / 1.25 / 1.5 / 2 / 3 / 4
TOL_FRAMES = 1.0
OUT_FPS = 30.0
FRAME_TOL_SEC = 1.0 / OUT_FPS


def find_tool(env_name: str, exe: str) -> str:
    explicit = os.environ.get(env_name)
    if explicit and os.path.isfile(explicit):
        return explicit
    localapp = os.environ.get("LOCALAPPDATA", "")
    if localapp:
        cand = os.path.join(localapp, "OrigHub", "bin", exe)
        if os.path.isfile(cand):
            return cand
    which = shutil.which(exe)
    if which:
        return which
    raise SystemExit(
        f"FAIL: {exe} not found. set {env_name} or install into %LOCALAPPDATA%/OrigHub/bin"
    )


FFMPEG = find_tool("ORIG_FFMPEG_PATH", "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
FFPROBE = find_tool("ORIG_FFPROBE_PATH", "ffprobe.exe" if os.name == "nt" else "ffprobe")


def run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"FAIL: {' '.join(cmd[:6])}...\n{p.stderr[-800:]}")


def make_source(path: str, fps: int, seconds: int) -> dict:
    """合成源（lavfi testsrc），返回 {duration, frames}。"""
    run(
        [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=320x240:rate={fps}:duration={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", path,
        ]
    )
    return probe(path)


def probe(path: str) -> dict:
    p = subprocess.run(
        [
            FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=nb_read_frames,avg_frame_rate,duration",
            "-of", "json", path,
        ],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        raise SystemExit(f"FAIL: ffprobe {path}: {p.stderr[-400:]}")
    s = json.loads(p.stdout)["streams"][0]
    num, _, den = s["avg_frame_rate"].partition("/")
    avg = float(num) / float(den) if den and float(den) != 0 else 0.0
    return {"duration": float(s["duration"]), "frames": int(s["nb_read_frames"]), "avg": avg}


def speed_value(speed_hundredths: int) -> float:
    return speed_hundredths / 100.0


def current_filter(speed_hundredths: int) -> str:
    """镜像 `routes.rs:3170 speed_video_filter`（改 Rust 必须同步改这里）。"""
    return f"setpts=(PTS-STARTPTS)/{speed_value(speed_hundredths):.2f},fps=30"


def proposed_filter(speed_hundredths: int, src_fps: float) -> str:
    """被否决的提案：`select=not(mod(n\,K))` + `setpts=N/30/TB`。"""
    k = round(src_fps * speed_value(speed_hundredths) / OUT_FPS)
    k = max(k, 1)  # mod(n,0) 非法，提案自身也必须先兜这个洞
    return f"select=not(mod(n\\,{k})),setpts=N/30/TB"


def encode(src: str, dst: str, vf: str) -> dict:
    run(
        [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
            "-vf", vf, "-an", "-r", "30",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", dst,
        ]
    )
    return probe(dst)


def main() -> int:
    falsify = "--falsify" in sys.argv
    workdir = tempfile.mkdtemp(prefix="orig_frc_verify_")
    results: list[tuple[str, bool, str]] = []

    try:
        # 源：30fps/10s（300 帧，用户场景）与 25fps/8s（非 30 的源帧率）
        sources = []
        for fps, secs in ((30, 10), (25, 8)):
            path = os.path.join(workdir, f"src{fps}.mp4")
            info = make_source(path, fps, secs)
            sources.append((fps, path, info))
            print(f"source {fps}fps: duration={info['duration']:.3f}s frames={info['frames']}")

        for fps, src, src_info in sources:
            for sp in SPEEDS:
                s = speed_value(sp)
                exp_dur = src_info["duration"] / s
                exp_frames = round(exp_dur * OUT_FPS)
                vf = proposed_filter(sp, fps) if falsify else current_filter(sp)
                out = os.path.join(workdir, f"out_{fps}_{sp}{'_mod' if falsify else ''}.mp4")
                got = encode(src, out, vf)

                ok_fps = got["avg"] == OUT_FPS
                ok_dur = abs(got["duration"] - exp_dur) <= FRAME_TOL_SEC
                ok_cnt = abs(got["frames"] - exp_frames) <= TOL_FRAMES
                ok = ok_fps and ok_dur and ok_cnt
                tag = f"{fps}fps {s}x"
                detail = (
                    f"vf='{vf}' -> avg={got['avg']:.3f} dur={got['duration']:.3f} "
                    f"(exp {exp_dur:.3f}) frames={got['frames']} (exp {exp_frames})"
                )
                results.append((tag, ok, detail))
                print(f"{'PASS' if ok else 'FAIL'} {tag}: {detail}")

        bad = [t for t, ok, _ in results if not ok]
        print()
        if falsify:
            # 反向证伪：提案必须**失败**，且失败的是 1.5x / 0.5x 这类非整数 K 与慢放档
            print(f"falsify: {len(bad)}/{len(results)} 档未通过判据")
            if not bad:
                print("FAIL: 判据对错误实现也全绿 —— 判据无牙")
                return 1
            print(f"PASS: 判据有牙，未通过档位 = {bad}")
            return 0
        print(f"summary: {len(results) - len(bad)}/{len(results)} PASS")
        if bad:
            print(f"FAIL: 未通过档位 = {bad}")
            return 1
        print("PASS: 全部速度档满足 30fps CFR + 时长=源/S ±1帧")
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
