#!/usr/bin/env node
// Diagnostic: can headless Edge reach a local loopback server at all?
const http = require('http');
const os = require('os');
const { spawn, execSync } = require('child_process');
// Edge 路径从环境变量推导，不写死盘符（污染门禁 §7）；可用 EDGE_PATH 覆盖
const EDGE = process.env.EDGE_PATH || [
  process.env['PROGRAMFILES(X86)'],
  process.env.PROGRAMFILES,
  process.env.LOCALAPPDATA,
]
  .filter(Boolean)
  .map((b) => require('path').join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  .find((p) => require('fs').existsSync(p));
const PORT = 19801;
const log = [];
const server = http.createServer((req, res) => {
  log.push('REQ ' + req.method + ' ' + req.url);
  if (req.url === '/x') { res.writeHead(200, {'content-type':'text/plain'}); res.end('hello'); return; }
  res.writeHead(200, {'content-type':'text/html'});
  res.end('<!doctype html><html><body><script>fetch("/x").then(r=>r.text()).then(t=>document.title="ok:"+t).catch(e=>document.title="err:"+e.message)</script></body></html>');
});
server.listen(PORT, '0.0.0.0', () => {
  log.push('LISTENING on ' + PORT);
  const ud = require('fs').mkdtempSync(require('path').join(os.tmpdir(), 'edge-diag-'));
  const args = ['--headless=new','--no-sandbox','--disable-gpu','--no-proxy-server','--proxy-bypass-list=*','--user-data-dir='+ud,'--window-size=400,300','http://127.0.0.1:'+PORT+'/'];
  const child = spawn(EDGE, args, { stdio: 'ignore', detached: true });
  const pid = child.pid;
  log.push('edge pid=' + pid);
  const t0 = Date.now();
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - t0 < 15000) Atomics.wait(sab, 0, 0, 500);
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch(_) {}
  try { require('fs').rmSync(ud,{recursive:true,force:true}); } catch(_) {}
  server.close();
  console.log(log.join('\n'));
});
