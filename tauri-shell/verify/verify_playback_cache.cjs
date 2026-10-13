#!/usr/bin/env node
/*
 * verify_playback_cache.cjs  (v3 — deterministic same-origin fetch, bypasses
 * the headless <video>/codec dead-end that made v2 a false negative).
 *
 * A local server serves BOTH the HTML page and the video from the SAME origin,
 * so fetch() is same-origin (no CORS/codec gate) and deterministically drives
 * the HTTP cache. Header varies by ?c=:
 *   maxage  -> 'public, max-age=31536000'   (OLD buggy behavior; must WRITE)
 *   nostore -> 'no-store'                   (FIX; must NOT write)
 * We measure the HTTP `Cache` dir delta. Server logs prove the fetch happened.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

// Edge 路径从环境变量推导，不写死盘符（污染门禁 §7）；可用 EDGE_PATH 覆盖
const EDGE = process.env.EDGE_PATH || [
  process.env['PROGRAMFILES(X86)'],
  process.env.PROGRAMFILES,
  process.env.LOCALAPPDATA,
]
  .filter(Boolean)
  .map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  .find((p) => fs.existsSync(p));
// 样本视频必须由调用方指定 —— 内容路径不入库（BUG-232），脚本内也不写死
const SRC_FILE = process.env.PROBE_FILE;
if (!SRC_FILE) {
  console.error('need PROBE_FILE=<local video path>');
  process.exit(2);
}
const TMP_VIDEO = path.join(os.tmpdir(), 'probe-video.mp4');
if (!fs.existsSync(TMP_VIDEO) || fs.statSync(TMP_VIDEO).size !== fs.statSync(SRC_FILE).size) {
  fs.copyFileSync(SRC_FILE, TMP_VIDEO);
}
const PORT = 19799;
const PLAY_MS = 25000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const c = new URLSearchParams(location.search).get('c') || 'maxage';
fetch('/file?c='+c).then(r => r.arrayBuffer()).then(b => {
  document.title = 'done:' + b.byteLength;
}).catch(e => { document.title = 'err:' + e.message; });
</script></body></html>`;

function dirSize(dir) {
  let t = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) t += dirSize(fp); else t += fs.statSync(fp).size;
  } } catch (_) {}
  return t;
}
function breakdown(ud) {
  const out = { total: dirSize(ud), dirs: {} };
  try { for (const e of fs.readdirSync(ud, { withFileTypes: true }))
    if (e.isDirectory()) out.dirs[e.name] = dirSize(path.join(ud, e.name)); } catch (_) {}
  return out;
}
function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (_) {} }

function startServer() {
  const s = { n: 0, reqs: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.writeHead(200, {'content-type':'text/html'}); res.end(PAGE); return; }
    if (u.pathname === '/file') {
      s.reqs++;
      const c = u.searchParams.get('c');
      const cc = c === 'nostore' ? 'no-store' : 'public, max-age=31536000';
      let st; try { st = fs.statSync(TMP_VIDEO); } catch (e) { res.writeHead(500); res.end(); return; }
      const range = req.headers.range; let start = 0, end = st.size - 1;
      if (range) { const m = /bytes=(\d*)-(\d*)/.exec(range); if (m){ if(m[1])start=+m[1]; if(m[2])end=+m[2]; }
        res.writeHead(206, {'content-type':'video/mp4','accept-ranges':'bytes','content-length':end-start+1,'content-range':`bytes ${start}-${end}/${st.size}`,'cache-control':cc});
      } else {
        res.writeHead(200, {'content-type':'video/mp4','accept-ranges':'bytes','content-length':st.size,'cache-control':cc});
      }
      const stream = fs.createReadStream(TMP_VIDEO, { start, end });
      stream.on('data', d => { s.n += d.length; });
      stream.pipe(res);
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(PORT, '127.0.0.1');
  return { server, s };
}

function run(c) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), `edge-ud-${c}-`));
  const before = breakdown(ud);
  const args = ['--headless=new','--no-sandbox','--disable-gpu','--no-proxy-server','--proxy-bypass-list=*','--user-data-dir='+ud,'--window-size=640,360',`http://127.0.0.1:${PORT}/?c=${c}`];
  const child = spawn(EDGE, args, { stdio: 'ignore', detached: true });
  const pid = child.pid;
  console.log(`[${c}] launched edge pid=${pid}`);
  const t0 = Date.now();
  while (Date.now() - t0 < PLAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  killTree(pid);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  const after = breakdown(ud);
  const cacheDelta = ((after.dirs['Cache']||0) - (before.dirs['Cache']||0)) / 1e6;
  console.log(`[${c}] TOTAL +${((after.total-before.total)/1e6).toFixed(1)} MB | HTTP 'Cache' dir +${cacheDelta.toFixed(1)} MB`);
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) {}
  return { cacheDelta, totalDelta: (after.total-before.total)/1e6 };
}

console.log('=== Playback-cache probe v3 (deterministic same-origin fetch) ===');
const ctrl = startServer();
const maxage = run('maxage');
const nostore = run('nostore');
console.log('=== RESULT ===');
console.log(`maxage (OLD): HTTP Cache dir +${maxage.cacheDelta.toFixed(1)} MB  | server sent ${(ctrl.s.n/1e6).toFixed(1)}MB over ${ctrl.s.reqs} reqs`);
console.log(`nostore (FIX): HTTP Cache dir +${nostore.cacheDelta.toFixed(1)} MB  | server sent ${(ctrl.s.n/1e6).toFixed(1)}MB over ${ctrl.s.reqs} reqs`);
if (ctrl.s.reqs < 2) {
  console.log('VERDICT: INVALID — fetch never reached server in both runs. Harness still broken.');
} else if (maxage.cacheDelta > 10 && nostore.cacheDelta < 1) {
  console.log('VERDICT: HTTP cache honors no-store — playback HTTP-disk-cache write is ELIMINATED. FIX CONFIRMED at the cache layer.');
} else if (maxage.cacheDelta > 10 && nostore.cacheDelta > 10) {
  console.log('VERDICT: HTTP cache IGNORED no-store — fix insufficient.');
} else {
  console.log('VERDICT: inconclusive (Cache dir did not grow even under max-age; headless Edge may not persist HTTP cache to disk).');
}
ctrl.server.close();
try { fs.unlinkSync(TMP_VIDEO); } catch (_) {}
