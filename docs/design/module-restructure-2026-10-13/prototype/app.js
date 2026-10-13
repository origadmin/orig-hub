/* Orig Hub 模块重整原型 v2 — 六项导航 / 纯静态 mock */
(function () {
  'use strict';

  /* ---------------- 顶部标题栏（各模块元数据） ---------------- */
  var META = {
    files:    { icon: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z', tint: 'rgba(34,211,238,.12)', color: '#22d3ee',
                title: '文件', sub: '受管字节事实层 · 默认首页（含非媒体文件）', actions: '<button class="btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15V3m0 0L8 7m4-4l4 4M5 21h14"/></svg>导入</button>' },
    download: { icon: 'M12 3v12m0 0l-4-4m4 4l4-4M5 21h14', tint: 'rgba(16,185,129,.15)', color: '#10b981',
                title: '下载', sub: '全局任务监控 · 引擎 + 全部插件唯一任务列表', actions: '<button class="btn primary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>新建下载</button>' },
    media:    { icon: 'M3 5h18v14H3z M9 10l5 3-5 3z', tint: 'rgba(167,139,250,.14)', color: '#a78bfa',
                title: '媒体库', sub: '策划层：内容 / 剧集 / 标签 · 播放器唯一出口', actions: '' },
    tg:       { icon: 'M22 3L2 10.5l7 2.5 3 7 3-4.5 5 4L22 3z', tint: 'rgba(56,189,248,.13)', color: '#38bdf8',
                title: 'TG 采集', sub: 'source-browser 标准屏 · 两级（无第三列）', actions: '' },
    share:    { icon: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1', tint: 'rgba(245,158,11,.14)', color: '#f59e0b',
                title: '共享', sub: '第二级：共享目标（服务总开关在设置）', actions: '' },
    settings: { icon: 'M12 15V3', tint: 'rgba(148,163,184,.13)', color: '#94a3b8',
                title: '设置', sub: '通用 / 下载存储 / 网络 / 播放引擎 / 账号 / 插件 / 共享服务', actions: '' }
  };

  var currentView = 'files';
  function renderCtx() {
    var m = META[currentView];
    document.getElementById('ctxbar').innerHTML =
      '<div class="ctx-title"><span class="t-ic" style="background:' + m.tint + ';color:' + m.color + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="' + m.icon + '"/></svg></span>' +
      m.title + '<span class="ctx-sub">' + m.sub + '</span></div>' +
      '<div class="ctx-actions">' + m.actions + '</div>';
  }
  function switchView(view, opts) {
    currentView = view;
    document.querySelectorAll('.nav-item').forEach(function (n) {
      n.classList.toggle('active', n.dataset.view === view);
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('on', v.id === 'view-' + view);
    });
    if (view === 'settings' && opts && opts.sec) showSection(opts.sec);
    var sb = document.getElementById('sb-msg');
    sb.textContent = { files: '文件：库根 12,482 项', download: '监控聚合中（5s · 有活才轮）', media: '媒体库 1,320 条目',
      tg: tgEnabled ? 'TG 插件已连接' : 'TG 插件未启用', share: shareOn ? '共享服务运行中' : '共享服务关闭', settings: '' }[view] || '就绪';
    renderCtx();
  }
  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.dataset.view, { sec: btn.dataset.sec }); });
  });

  /* ---------------- 下载：全局任务监控（引擎 + 插件） ---------------- */
  // kind=core 引擎任务（字节）；kind=tg TG 缓存任务（条目数，无真暂停——协议铁律）
  var JOBS = [
    { gid: 'core:TRC-00012-1', source: 'core', name: 'archive-demo.mkv', meta: '视频 · 482 MB · HEVC', tab: 'running', pct: 62, line: '2.4 MB/s · 剩余 1:20' },
    { gid: 'tg:31', source: 'tg', name: '影视频道 X · 4K 原盘分享', meta: '缓存任务 · 30 条消息 · 2 相册组', tab: 'running', pct: 40, line: '12 / 30 条 · 当前条目 48 / 210 MB', unit: 'items' },
    { gid: 'core:TRC-00009-1', source: 'core', name: 'lesson-12.mp4', meta: '视频 · 210 MB · H.264', tab: 'running', pct: 88, line: '5.1 MB/s · 剩余 0:05' },
    { gid: 'core:TRC-00010-1', source: 'core', name: 'paused-thing.zip', meta: '压缩包 · 12 MB', tab: 'paused', pct: 28, line: '已暂停' },
    { gid: 'tg:30', source: 'tg', name: '纪录片频道 Y · 批量缓存', meta: '缓存任务 · 20 条 · interrupted', tab: 'failed', pct: 40, line: '中断（网络） · TG 无续传，只能整任务重试', unit: 'items', failed: true },
    { gid: 'core:TRC-00011-1', source: 'core', name: 'song.flac', meta: '音频 · 38 MB', tab: 'done', pct: 100, line: '校验通过 · 完成于 11:42' },
    { gid: 'tg:29', source: 'tg', name: '摄影频道 Z · 九月合集', meta: '缓存任务 · 86 张图片', tab: 'done', pct: 100, line: '已归库 · 完成于 10:20', unit: 'items' },
    { gid: 'core:TRC-00008-1', source: 'core', name: 'manual.pdf', meta: '文档 · 3.4 MB', tab: 'done', pct: 100, line: '完成于 昨天' },
    { gid: 'core:TRC-00007-1', source: 'core', name: 'photo-batch.zip', meta: '压缩包 · 88 MB', tab: 'done', pct: 100, line: '完成于 周二' }
  ];
  var dlTab = 'all', dlSrc = 'all';

  function dlTypeIcon(meta) {
    if (meta.indexOf('视频') === 0) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3V9z"/></svg>';
    if (meta.indexOf('音频') === 0) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>';
    if (meta.indexOf('缓存任务') === 0) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 3L2 10.5l7 2.5 3 7 3-4.5 5 4L22 3z"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/></svg>';
  }
  function tabOf(j) { return j.tab === 'failed' ? 'all' : j.tab; }
  function renderDownloads() {
    var rows = JOBS.filter(function (j) {
      if (dlTab !== 'all' && tabOf(j) !== dlTab) return false;
      if (dlSrc !== 'all' && j.source !== dlSrc) return false;
      return true;
    });
    document.getElementById('dl-list').innerHTML = rows.map(function (j) {
      var srcChip = j.source === 'tg'
        ? '<span class="chip cy">TG 缓存</span>'
        : '<span class="chip">引擎</span>';
      var stateChip = j.tab === 'running' ? '<span class="chip em">下载中</span>'
        : j.tab === 'paused' ? '<span class="chip am">已暂停</span>'
        : j.tab === 'failed' ? '<span class="chip ro">需处理</span>'
        : '<span class="chip">完成</span>';
      var bar = j.source === 'tg' ? 'background:linear-gradient(90deg,#38bdf8,#22d3ee)' : '';
      var actions;
      if (j.source === 'tg' && j.tab === 'running') actions = '<span class="no-act">运行中不可暂停（无真续传）</span>';
      else if (j.tab === 'failed') actions = '<button class="btn sm primary">整任务重试</button>';
      else if (j.tab === 'running') actions = '<button class="btn sm">暂停</button><button class="btn sm">详情</button>';
      else if (j.tab === 'paused') actions = '<button class="btn sm primary">继续</button><button class="btn sm">详情</button>';
      else actions = '<button class="btn sm">定位文件</button><button class="btn sm">详情</button>';
      return '<div class="dl-row"><div class="dlic">' + dlTypeIcon(j.meta) + '</div>' +
        '<div class="dl-main"><div class="t1"><span class="idcode">' + j.gid + '</span> ' + j.name + ' ' + srcChip + stateChip + '</div>' +
        '<div class="progress"><i style="width:' + j.pct + '%;' + bar + '"></i></div>' +
        '<div class="t2"><span>' + j.meta + '</span><span>' + j.line + '</span></div></div>' +
        '<div class="dl-actions">' + actions + '</div></div>';
    }).join('') || '<div class="empty-hint">该筛选下没有任务</div>';

    // 健康条：插件不可用时聚合降级（引擎任务恒显示）
    document.getElementById('dl-health').style.display = tgEnabled ? 'none' : 'block';
    document.getElementById('dl-health').textContent = tgEnabled ? ''
      : 'TG 插件未启用/不可达：其任务本次不参与聚合（来源：tg unavailable），下载引擎任务不受影响。';
  }
  function refreshCounts() {
    var cnt = { all: JOBS.length, running: 0, paused: 0, done: 0 };
    JOBS.forEach(function (j) {
      if (j.tab === 'running') cnt.running++;
      else if (j.tab === 'paused') cnt.paused++;
      else if (j.tab === 'done') cnt.done++;
    });
    Object.keys(cnt).forEach(function (k) {
      var el = document.querySelector('[data-cnt="' + k + '"]');
      if (el) el.textContent = cnt[k];
    });
    var inTransit = cnt.running;
    var badge = document.getElementById('nav-dl-cnt');
    badge.textContent = inTransit; badge.style.display = inTransit ? '' : 'none';
  }
  document.getElementById('dl-tabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab'); if (!t) return;
    dlTab = t.dataset.dltab;
    document.querySelectorAll('#dl-tabs .tab').forEach(function (x) { x.classList.toggle('on', x === t); });
    renderDownloads();
  });
  document.getElementById('src-chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b || b.disabled) return;
    dlSrc = b.dataset.src;
    document.querySelectorAll('#src-chips .chip').forEach(function (x) {
      x.classList.toggle('em', x === b && dlSrc !== 'tg');
      x.classList.toggle('cy', x === b && dlSrc === 'tg');
    });
    renderDownloads();
  });
  refreshCounts(); renderDownloads();

  /* ---------------- 文件：事实层（分类筛选 + 事实行） ---------------- */
  var GLYPH = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3V9z"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 8h4M10 12h4M10 16h4"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>'
  };
  var FACTS = [
    { g: 'folder', cat: 'all', name: '2026/', sub: '12 项 · 8.4 GB', size: '', origin: '', otype: '', act: '' },
    { g: 'video', cat: 'video', name: 'demo.mkv', sub: '2026/ · 修改于 10-12', size: '482 MB', origin: 'TG', otype: 'cy', act: '定位' },
    { g: 'video', cat: 'video', name: 'lesson-12.mp4', sub: '下载任务 core:TRC-00009-1', size: '210 MB', origin: '下载', otype: 'em', act: '定位' },
    { g: 'image', cat: 'image', name: 'cover-set/', sub: '12 张图片', size: '36 MB', origin: 'TG', otype: 'cy', act: '定位' },
    { g: 'audio', cat: 'audio', name: 'song.flac', sub: '下载任务 core:TRC-00011-1', size: '38 MB', origin: '下载', otype: 'em', act: '定位' },
    { g: 'doc', cat: 'doc', name: 'manual.pdf', sub: '非媒体 · 不出现在媒体库', size: '3.4 MB', origin: '下载', otype: 'em', act: '打开位置' },
    { g: 'archive', cat: 'archive', name: 'photo-batch.zip', sub: '非媒体 · 仅文件层可见', size: '88 MB', origin: '下载', otype: 'em', act: '打开位置' },
    { g: 'warn', cat: 'video', name: 'old-deleted.mp4', sub: '有条目但文件缺失（孤儿条目）', size: '—', origin: 'TG', otype: 'cy', act: '移除条目' }
  ];
  var fileCat = 'all';
  function renderFacts() {
    document.getElementById('fact-rows').innerHTML = FACTS.filter(function (f) {
      return fileCat === 'all' || f.cat === fileCat;
    }).map(function (f) {
      return '<div class="fact-row"><div class="fi" style="background:var(--panel-3)">' + GLYPH[f.g] + '</div>' +
        '<div class="fr-path">' + f.name + '<small>' + f.sub + '</small></div>' +
        '<span class="fr-size">' + f.size + '</span>' +
        '<span class="origin-tag">' + (f.otype ? '<span class="chip ' + f.otype + '">' + f.origin + '</span>' : '') + '</span>' +
        '<span>' + (f.act ? '<button class="btn sm">' + f.act + '</button>' : '') + '</span></div>';
    }).join('');
  }
  document.getElementById('file-cats').addEventListener('click', function (e) {
    var b = e.target.closest('.subtab'); if (!b) return;
    fileCat = b.dataset.cat;
    document.querySelectorAll('#file-cats .subtab').forEach(function (x) { x.classList.toggle('on', x === b); });
    renderFacts();
  });
  renderFacts();

  /* ---------------- 媒体库：内容 / 剧集 / 标签 ---------------- */
  function playIcon() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; }
  var MEDIA = [
    { t: '演示片段 4K Demo', m: '视频 · 12′ · 482 MB', c: 'v', d: '12:03', src: 'TG' },
    { t: '城市夜景延时', m: '视频 · 3′06″ · 118 MB', c: 'v', d: '3:06', src: '下载' },
    { t: '讲座录音 EP12', m: '音频 · 48′ · 46 MB', c: 'a', d: '48:10', src: '导入' },
    { t: '封面素材组', m: '图片 · 12 张', c: 'p', d: '', src: 'TG' },
    { t: '纪录片 S02E03', m: '视频 · 52′ · 4.2 GB', c: 'v', d: '52:41', src: 'TG' },
    { t: '产品演示 2026', m: '视频 · 8′ · 260 MB', c: 'v', d: '8:12', src: '导入' },
    { t: '电影配乐合集', m: '音频 · 12 首 · 320 MB', c: 'a', d: '', src: 'TG' },
    { t: '旅行相册', m: '图片 · 86 张', c: 'p', d: '', src: '导入' }
  ];
  document.getElementById('media-cards').innerHTML = MEDIA.map(function (x) {
    return '<div class="mcard"><div class="thumb ' + x.c + '"><span class="badge-src">' + x.src + '</span>' +
      (x.c === 'v' ? playIcon() : x.c === 'a'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>') +
      (x.d ? '<span class="dur">' + x.d + '</span>' : '') + '</div>' +
      '<div class="mc-body"><div class="mc-t">' + x.t + '</div><div class="mc-m"><span>' + x.m + '</span></div></div></div>';
  }).join('');
  var SERIES = ['纪录片精选', '科幻短片季', '摄影教程合集', '2026 新剧', '古典音乐会', '旅行 Vlog 合集', 'BBC 自然系列', '动画短篇'];
  document.getElementById('series-cards').innerHTML = SERIES.map(function (s, i) {
    return '<div class="mcard"><div class="thumb v" style="background:linear-gradient(135deg,#1d2a3a,#13202c)">' + playIcon() +
      '<span class="dur">' + (6 + i) + ' 集</span></div><div class="mc-body"><div class="mc-t">' + s + '</div>' +
      '<div class="mc-m"><span>剧集 · 2026</span></div></div></div>';
  }).join('');
  var TAGS = ['4K', 'HEVC', '纪录片', '讲座', '合集', '待整理', '已归档', '音乐现场', '延时摄影', '中英字幕', '无损音频', '短视频', 'RAW', '精选'];
  document.getElementById('tag-cloud').innerHTML = TAGS.map(function (t, i) {
    return '<button class="chip ' + (i % 4 === 0 ? 'em' : i % 4 === 1 ? 'cy' : '') + '">#' + t + '</button>';
  }).join('');
  document.querySelectorAll('.rail-item').forEach(function (r) {
    r.addEventListener('click', function () {
      document.querySelectorAll('.rail-item').forEach(function (x) { x.classList.toggle('on', x === r); });
      ['contents', 'series', 'tags'].forEach(function (p) {
        document.getElementById('pane-' + p).style.display = p === r.dataset.rail ? '' : 'none';
      });
    });
  });
  document.querySelectorAll('#pane-contents .subtab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('#pane-contents .subtab').forEach(function (x) { x.classList.toggle('on', x === t); });
    });
  });

  /* ---------------- TG：两级 source-browser ---------------- */
  var DIALOGS = [
    { id: 1, name: '影视频道 X', flt: 'mon', folder: 'all', monitored: true, count: 1284, active: true },
    { id: 2, name: '纪录片频道 Y', flt: 'mon', folder: 'study', monitored: true, count: 860 },
    { id: 3, name: '摄影频道 Z', flt: 'mon', folder: 'photo', monitored: true, count: 432 },
    { id: 4, name: '电影讨论群', flt: 'group', folder: 'all', monitored: false, count: 51 },
    { id: 5, name: '4K 原盘分享', flt: 'all', folder: 'all', monitored: false, count: 96 },
    { id: 6, name: '技术交流群', flt: 'group', folder: 'study', monitored: false, count: 18 },
    { id: 7, name: '摄影素材频道', flt: 'all', folder: 'photo', monitored: false, count: 210 },
    { id: 8, name: '老王（私聊）', flt: 'private', folder: 'all', monitored: false, count: 7 },
    { id: 9, name: '资源助手（私聊）', flt: 'private', folder: 'all', monitored: false, count: 3 }
  ];
  var tgFlt = 'all', tgFolder = 'all', tgSelected = 1;

  function renderDialogs() {
    document.getElementById('tg-dialogs').innerHTML = DIALOGS.filter(function (d) {
      if (tgFlt === 'mon' && !d.monitored) return false;
      if (tgFlt === 'group' && d.flt !== 'group') return false;
      if (tgFlt === 'private' && d.flt !== 'private') return false;
      if (tgFolder !== 'all' && d.folder !== 'all' && d.folder !== tgFolder) return false;
      return true;
    }).map(function (d) {
      return '<div class="dlg-row' + (d.id === tgSelected ? ' on' : '') + '" data-id="' + d.id + '">' +
        '<span class="m-dot ' + (d.monitored ? 'on' : '') + '" title="' + (d.monitored ? '监控中（点击取消）' : '未监控（点击监控）') + '"></span>' +
        '<span class="dlg-name">' + d.name + '</span>' +
        '<span class="badge-count">' + d.count + '</span></div>';
    }).join('') || '<div class="empty-hint">该筛选下无会话</div>';
  }
  document.getElementById('tg-dialogs').addEventListener('click', function (e) {
    var dot = e.target.closest('.m-dot');
    var row = e.target.closest('.dlg-row');
    if (!row) return;
    var id = Number(row.dataset.id);
    var d = DIALOGS.find(function (x) { return x.id === id; });
    if (dot) { d.monitored = !d.monitored; e.stopPropagation(); renderDialogs(); return; }
    tgSelected = id;
    document.getElementById('tg-head-title').textContent = d.name;
    renderDialogs();
  });
  document.getElementById('tg-filter').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    tgFlt = b.dataset.flt;
    document.querySelectorAll('#tg-filter button').forEach(function (x) { x.classList.toggle('on', x === b); });
    renderDialogs();
  });
  document.getElementById('tg-folders').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    tgFolder = b.dataset.folder;
    document.querySelectorAll('#tg-folders .chip').forEach(function (x) { x.classList.toggle('em', x === b); });
    renderDialogs();
  });
  document.getElementById('btn-tg-manage').addEventListener('click', function () {
    switchView('settings', { sec: 'accounts' });
  });
  document.getElementById('btn-go-download').addEventListener('click', function () { switchView('download'); });
  renderDialogs();

  /* ---------------- 全局状态：TG 启用 / 共享服务 ---------------- */
  var tgEnabled = true, shareOn = false;
  function applyTg() {
    document.getElementById('tg-active').style.display = tgEnabled ? '' : 'none';
    document.getElementById('tg-onboarding').style.display = tgEnabled ? 'none' : '';
    document.getElementById('tg-nav-dot').className = 'nav-dot ' + (tgEnabled ? 'on' : 'off');
    var tag = document.getElementById('tg-state-tag');
    if (tag) { tag.textContent = tgEnabled ? '已启用' : '已停用'; tag.className = 'tag-state ' + (tgEnabled ? 'on' : 'soon'); }
    var sw = document.getElementById('tg-en-switch'); if (sw) sw.classList.toggle('on', tgEnabled);
    var conn = document.getElementById('sb-conn');
    conn.textContent = '实时连接 · daemon 19786' + (tgEnabled ? ' · tg 插件已连接' : ' · tg 插件未启用（库内内容照常可用）');
    renderDownloads();
  }
  function applyShare() {
    document.getElementById('share-off').style.display = shareOn ? 'none' : '';
    document.getElementById('share-on').style.display = shareOn ? '' : 'none';
    document.getElementById('share-nav-dot').className = 'nav-dot ' + (shareOn ? 'on' : 'off');
    var sw = document.getElementById('share-en-switch'); if (sw) sw.classList.toggle('on', shareOn);
  }
  document.getElementById('tg-state-seg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    tgEnabled = b.dataset.tg === 'on';
    document.querySelectorAll('#tg-state-seg button').forEach(function (x) { x.classList.toggle('on', x === b); });
    applyTg();
  });
  document.getElementById('share-state-seg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    shareOn = b.dataset.share === 'on';
    document.querySelectorAll('#share-state-seg button').forEach(function (x) { x.classList.toggle('on', x === b); });
    applyShare();
  });
  document.getElementById('tg-en-switch').addEventListener('click', function () {
    tgEnabled = !tgEnabled;
    document.querySelectorAll('#tg-state-seg button').forEach(function (x) {
      x.classList.toggle('on', (x.dataset.tg === 'on') === tgEnabled);
    });
    applyTg();
  });
  document.getElementById('share-en-switch').addEventListener('click', function () {
    shareOn = !shareOn;
    document.querySelectorAll('#share-state-seg button').forEach(function (x) {
      x.classList.toggle('on', (x.dataset.share === 'on') === shareOn);
    });
    applyShare();
  });
  document.getElementById('go-tg-settings').addEventListener('click', function () {
    switchView('settings', { sec: 'plugins' });
  });
  document.getElementById('go-share-settings').addEventListener('click', function () {
    switchView('settings', { sec: 'share' });
  });
  document.getElementById('share-goto-svc').addEventListener('click', function () {
    switchView('settings', { sec: 'share' });
  });

  /* 共享目标 mock */
  var TARGETS = [
    { name: '整个媒体库', scope: 'library', token: 'tok-lib-9f3a', on: true, exp: '长期', hits: 2 },
    { name: '纪录片精选（剧集）', scope: 'series:12', token: 'tok-doc-2b71', on: true, exp: '2026-10-20', hits: 1 },
    { name: '#4K 标签', scope: 'tag:4K', token: 'tok-4k-77ce', on: false, exp: '7 天', hits: 0 }
  ];
  document.getElementById('share-targets').innerHTML = TARGETS.map(function (x) {
    return '<div class="target-row"><div class="tgt-main"><div class="tgt-name">' + x.name + ' <span class="chip">' + x.scope + '</span></div>' +
      '<div class="tgt-meta"><code>' + x.token + '</code> · 有效期 ' + x.exp + ' · 访问 ' + x.hits + ' 次</div></div>' +
      '<span class="qr sm"><i class="w"></i><i></i><i class="w"></i><i></i><i></i><i class="w"></i><i></i></span>' +
      '<button class="switch ' + (x.on ? 'on' : '') + ' tgt-sw"></button>' +
      '<button class="btn sm danger">撤销</button></div>';
  }).join('');
  document.getElementById('share-targets').addEventListener('click', function (e) {
    var sw = e.target.closest('.tgt-sw'); if (sw) sw.classList.toggle('on');
  });

  /* 伪二维码 */
  (function () {
    var cells = '';
    for (var i = 0; i < 49; i++) cells += '<i class="' + (Math.random() > 0.52 ? 'w' : '') + '"></i>';
    document.getElementById('qr').innerHTML = cells;
  })();

  /* ---------------- 设置分区 ---------------- */
  function showSection(sec) {
    document.querySelectorAll('.set-nav-item').forEach(function (n) { n.classList.toggle('on', n.dataset.sec === sec); });
    document.querySelectorAll('.set-section').forEach(function (s) { s.classList.toggle('on', s.id === 'sec-' + sec); });
  }
  document.getElementById('set-nav').addEventListener('click', function (e) {
    var b = e.target.closest('.set-nav-item'); if (b) showSection(b.dataset.sec);
  });
  document.querySelectorAll('.set-section .switch').forEach(function (sw) {
    if (sw.id === 'tg-en-switch' || sw.id === 'share-en-switch') return;
    sw.addEventListener('click', function (e) { e.stopPropagation(); sw.classList.toggle('on'); });
  });

  applyTg(); applyShare(); renderCtx();
})();
