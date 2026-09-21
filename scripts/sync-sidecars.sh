#!/usr/bin/env sh
# 同步 sidecar 二进制，并让「陈旧」变成可见错误。
#
# 背景（BUG-055 / BUG-061）：`tauri.conf.json` 的 externalBin 给的是不含目标三元组的路径
# `.../release/orig-tg`，Tauri 会按平台解析成 `orig-tg-x86_64-pc-windows-msvc.exe`，
# 再把它**复制进壳自己的 target 目录**（`tauri-shell/src-tauri/target/{debug,release}/`）。
# 于是同一份引擎在仓库里有**四处**副本，而 `cargo build --release` 只更新其中一处：
#
#   1) download-engine/target/release/orig-tg.exe                          ← cargo 产出（新）
#   2) download-engine/target/release/orig-tg-<triple>.exe                 ← Tauri 读取源
#   3) tauri-shell/src-tauri/target/debug/orig-tg.exe                      ← tauri dev 实际启动它
#   4) tauri-shell/src-tauri/target/release/orig-tg.exe                    ← 打包壳实际启动它
#
# 只同步 2) 不够：已构建好的壳不会因为源变了就重新复制 3)/4)，用户启动的 app 仍在跑旧引擎，
# 表现为「代码改了、验收脚本全绿、用户体感不变」。本脚本把 2)3)4) 一并刷新，
# 并在**源二进制比引擎源码旧**时直接失败（陈旧必须响，不能静默）。
#
# 用法：sh scripts/sync-sidecars.sh [--check]
#   --check  只校验，不写盘（供门禁调用）
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REL="$ROOT/download-engine/target/release"
SHELL_TAURI="$ROOT/tauri-shell/src-tauri/target"
TRIPLE="x86_64-pc-windows-msvc"
MODE="${1:-sync}"

fail() { echo "sync-sidecars: FAIL - $*" >&2; exit 1; }
info() { echo "sync-sidecars: $*"; }

# 每个产物的**依赖源码集合**（自身 crate + 它依赖的 workspace crate）。
#
# 为什么不能把所有 crates 一起扫：那样改一次 orig-tg 就会把 orig-daemon 也判成陈旧，
# 门禁于是逼着人去重建一个根本没变的二进制；CI 上 `--check` 更会因为「另一个 crate
# 的源码更新了」而恒红 —— 判据跨 crate 串扰，门禁沦为噪音（本脚本原先是全量扫）。
# 依赖照抄 crates/*/Cargo.toml，改了依赖要同步这里。
deps_of() {
  case "$1" in
    orig-tg) echo "orig-tg orig-core" ;;
    orig-daemon) echo "orig-daemon orig-core orig-net orig-protocol-http orig-protocol-virtual" ;;
    *) echo "$1" ;;
  esac
}

# 该产物对应源码里比它新的那个文件（无则返回非 0）。Cargo.toml 也算 —— 依赖变更需要重建。
newest_src() {
  _name="$1"
  _bin="$2"
  for _c in $(deps_of "$_name"); do
    _d="$ROOT/download-engine/crates/$_c"
    [ -d "$_d" ] || continue
    _f="$(find "$_d" \( -name '*.rs' -o -name 'Cargo.toml' \) -newer "$_bin" 2>/dev/null | head -1)"
    if [ -n "$_f" ]; then
      echo "$_f"
      return 0
    fi
  done
  return 1
}

# 取目标三元组（非 Windows 时 Tauri 会用别的后缀，这里按主机推导）。
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) TRIPLE="x86_64-pc-windows-msvc" ;;
  Linux) TRIPLE="x86_64-unknown-linux-gnu" ;;
  Darwin) TRIPLE="x86_64-apple-darwin" ;;
esac

STALE=0
missing=0
# 壳 target 里「该到位却缺失」的产物数（check 模式下只告警，不阻断 —— 未构建过壳是合法的）。
MISSING=0

for name in orig-tg orig-daemon; do
  SRC="$REL/$name.exe"
  [ -f "$SRC" ] || SRC="$REL/$name"
  if [ ! -f "$SRC" ]; then
    info "WARN - $name: 未找到 release 产物（$SRC），跳过。先跑 cargo build --release。"
    missing=$((missing + 1))
    continue
  fi

  # 陈旧检测：**本 crate 及其依赖**里有源码比该二进制新 ⇒ 二进制没反映最新代码。
  newer="$(newest_src "$name" "$SRC" || true)"
  if [ -n "$newer" ]; then
    info "WARN - $name: 产物比源码旧（如 ${newer#$ROOT/}），产物未反映最新代码。"
    STALE=$((STALE + 1))
  fi

  TARGETS="$REL/$name-$TRIPLE.exe"
  [ "$MODE" = "--check" ] || cp -f "$SRC" "$TARGETS"

  for d in debug release; do
    D="$SHELL_TAURI/$d"
    [ -d "$D" ] || continue
    for fn in "$name.exe" "$name-$TRIPLE.exe"; do
      # 「目标文件不存在就跳过」是**假绿**的温床（BUG-106 实踩）：
      # 为了让开 Windows 的文件占用，惯例是把被占用的 exe 改名成 `*.locked-by-<pid>`，
      # 改名后这里看到「文件不存在」就 continue，于是新二进制根本没写进去，
      # 而脚本照样输出 OK —— 壳继续跑旧引擎，用户体感「改了没生效」且没有任何提示。
      #
      # 正确做法：sync 模式一律写（目录存在即认为该产物该到位）；check 模式对缺失告警，
      # 让「从来没同步过」变成可见信息而不是静默通过。
      if [ -e "$D/$fn" ]; then
        [ "$MODE" = "--check" ] || cp -f "$SRC" "$D/$fn" || fail "$name: 无法写入 $d/$fn（可能被运行中的进程占用，先把该 exe 改名成 *.locked-by-<pid> 再重试）"
      elif [ "$MODE" = "--check" ]; then
        info "WARN - $name: 壳 target 缺少 $d/$fn（尚未同步过）"
        MISSING=$((MISSING + 1))
      else
        cp -f "$SRC" "$D/$fn" || fail "$name: 无法写入 $d/$fn（可能被运行中的进程占用，先把该 exe 改名成 *.locked-by-<pid> 再重试）"
      fi
    done
  done
done

# 对账：externalBin 源与主产物必须逐字节一致。
for name in orig-tg orig-daemon; do
  SRC="$REL/$name.exe"
  DST="$REL/$name-$TRIPLE.exe"
  [ -f "$SRC" ] && [ -f "$DST" ] || continue
  if ! cmp -s "$SRC" "$DST"; then
    fail "$name: externalBin 源与 cargo 产物不一致（$DST != $SRC）"
  fi
done

if [ "$STALE" -gt 0 ]; then
  fail "$STALE 个产物比源码旧 —— 请先 cargo build --release 再同步；用户进程会跑旧引擎。"
fi
if [ "$missing" -gt 0 ]; then
  info "WARN - $missing 个产物缺失，已跳过（未阻断）。"
fi
if [ "$MISSING" -gt 0 ]; then
  info "WARN - $MISSING 个壳 target 产物缺失（sync 模式会自动补齐，未阻断）。"
fi

[ "$MODE" = "--check" ] && info "OK - sidecar 产物与源码同步（check only）" || info "OK - sidecar 已同步到 externalBin 源与壳 target（debug/release）"
