/* Orig Hub 模块重整原型 v3 — 五项导航 + 双树 / 纯静态 mock */
(function () {
  'use strict';

  /* ================= 顶部上下文栏 ================= */
  var META = {
    files:    { icon: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z', tint: 'rgba(34,211,238,.12)', color: '#22d3ee',
                title: '全部文件', actions: '<button class="btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15V3m0 0L8 7m4-4l4 4M5 21h14"/></svg>导入</button>' },
    download: { icon: 'M12 3v12m0 0l-4-4m4 4l4-4M5 21h14', tint: 'rgba(16,185,129,.15)', color: '#10b981',
                title: '下载', sub: '全部任务 · 全局监控（引擎 + 全部插件）', actions: '<button class="btn primary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>新建下载</button>' },
    tg:       { icon: 'M22 3L2 10.5l7 2.5 3 7 3-4.5 5 4L22 3z', tint: 'rgba(56,189,248,.13)', color: '#38bdf8',
                title: 'TG 采集', sub: 'source-browser 标准屏 · 两级（无第三列）', actions: '' },
    share:    { icon: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1', tint: 'rgba(245,158,11,.14)', color: '#f59e0b',
                title: '共享', sub: '第二级：共享目标（服务总开关在设置）', actions: '' },
    settings: { icon: 'M12 15V3', tint: 'rgba(148,163,184,.13)', color: '#94a3b8',
                title: '设置', sub: '通用 / 下载存储 / 网络 / 播放引擎 / 账号 / 插件 / 共享服务', actions: '' }
  };
  var FILE_SUBS = {
    'cat-all': '全部成品内容（媒体 + 非媒体文件）· 只显示成品，任务在「下载」',
    'cat-video': '分类 · 视频（成品内容）',
    'cat-audio': '分类 · 音乐（成品内容）',
    'cat-image': '分类 · 图片（成品内容）',
    'cat-doc': '分类 · 文档（非媒体文件）',
    'cat-archive': '分类 · 压缩包（非媒体文件）',
    'cat-other': '分类 · 其他文件',
    'lib-series': '资料库 · 剧集（策划层：本页不铺开内容，点剧集管理成员）',
    'lib-tags': '资料库 · 标签（交叉分类，不改变归档状态）',
    'lib-unfiled': '资料库 · 未归档（有条目但未归入任何剧集）'
  };

  var currentView = 'files';
  function filesSub() {
    if (currentView !== 'files') return null;
    if (sdSeries) return '剧集详情 · 成员管理（从剧集移除 ≠ 删除字节/条目，BUG-112）';
    return FILE_SUBS[fmode] || FILE_SUBS['cat-all'];
  }
  var DL_SUBS = {
    all: '全部任务 · 全局监控（引擎 + 全部插件）',
    running: '下载中（侧栏预设过滤）',
    paused: '已暂停（侧栏预设过滤；TG 无暂停能力，不出现 TG 行）',
    done: '已完成（侧栏预设过滤）'
  };
  function renderCtx() {
    var m = META[currentView];
    var sub = currentView === 'files' ? filesSub()
      : currentView === 'download' ? DL_SUBS[dlTab]
      : m.sub;
    document.getElementById('ctxbar').innerHTML =
      '<div class="ctx-title"><span class="t-ic" style="background:' + m.tint + ';color:' + m.color + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="' + m.icon + '"/></svg></span>' +
      m.title + '<span class="ctx-sub">' + sub + '</span></div>' +
      '<div class="ctx-actions">' + m.actions + '</div>';
  }

  /* ================= 视图切换 & 两棵树 ================= */
  function syncNav() {
    document.querySelectorAll('.nav-item').forEach(function (n) {
      n.classList.toggle('active', n.dataset.view === currentView);
    });
    document.getElementById('nav-files-row').classList.toggle('active', currentView === 'files');
    document.getElementById('nav-dl-row').classList.toggle('active', currentView === 'download');
    document.querySelectorAll('.nav-child').forEach(function (c) {
      var on = false;
      if (c.dataset.fmode) on = currentView === 'files' && !sdSeries && c.dataset.fmode === fmode;
      if (c.dataset.dltab) on = currentView === 'download' && c.dataset.dltab === dlTab;
      c.classList.toggle('on', on);
    });
  }
  function switchView(view, opts) {
    currentView = view;
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('on', v.id === 'view-' + view);
    });
    if (view === 'settings' && opts && opts.sec) showSection(opts.sec);
    if (view === 'download' && opts && opts.dltab) setDlTab(opts.dltab);
    if (view === 'files' && opts && opts.fmode) setFmode(opts.fmode);
    var sb = document.getElementById('sb-msg');
    sb.textContent = {
      files: '全部文件：128 个成品（媒体 121 · 文件 7）',
      download: '监控聚合中（5s · 有活才轮）',
      tg: tgEnabled ? 'TG 插件已连接' : 'TG 插件未启用',
      share: shareOn ? '共享服务运行中' : '共享服务关闭',
      settings: ''
    }[view] || '就绪';
    syncNav(); renderCtx();
  }
  // 父行主按钮（data-view）与普通一级项
  document.querySelectorAll('.nv-main, .nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchView(btn.dataset.view, { sec: btn.dataset.sec, dltab: btn.dataset.dltab, fmode: btn.dataset.fmode });
    });
  });
  // 树子项（侧栏预设过滤）
  document.querySelectorAll('.nav-child').forEach(function (c) {
    c.addEventListener('click', function () {
      if (c.dataset.fmode) switchView('files', { fmode: c.dataset.fmode });
      if (c.dataset.dltab) switchView('download', { dltab: c.dataset.dltab });
    });
  });
  // chevron：只翻转展开态，不导航（沿用现状 Sidebar 双点击原语）
  function bindChevron(btnId, subId, key) {
    document.getElementById(btnId).addEventListener('click', function () {
      treeOpen[key] = !treeOpen[key];
      document.getElementById(subId).style.display = treeOpen[key] ? '' : 'none';
      btnId && document.getElementById(btnId).setAttribute('aria-expanded', String(treeOpen[key]));
      document.getElementById(btnId).classList.toggle('open', treeOpen[key]);
    });
    document.getElementById(btnId).classList.add('open');
  }
  var treeOpen = { files: true, dl: true };
  bindChevron('files-chev', 'files-sub', 'files');
  bindChevron('dl-chev', 'dl-sub', 'dl');

  /* ================= 下载：全部任务 · 全局监控 ================= */
  var JOBS = [
    { gid: 'core:TRC-00012-1', source: 'core', name: 'archive-demo.mkv', meta: '视频 · 482 MB · HEVC', tab: 'running', pct: 62, line: '2.4 MB/s · 剩余 1:20' },
    { gid: 'tg:31', source: 'tg', name: '影视频道 X · 4K 原盘分享', meta: '缓存任务 · 30 条消息 · 2 相册组', tab: 'running', pct: 40, line: '12 / 30 条 · 当前条目 48 / 210 MB' },
    { gid: 'core:TRC-00009-1', source: 'core', name: 'lesson-12.mp4', meta: '视频 · 210 MB · H.264', tab: 'running', pct: 88, line: '5.1 MB/s · 剩余 0:05' },
    { gid: 'core:TRC-00010-1', source: 'core', name: 'paused-thing.zip', meta: '压缩包 · 12 MB', tab: 'paused', pct: 28, line: '已暂停' },
    { gid: 'tg:30', source: 'tg', name: '纪录片频道 Y · 批量缓存', meta: '缓存任务 · 20 条 · interrupted', tab: 'failed', pct: 40, line: '中断（网络） · TG 无续传，只能整任务重试', failed: true },
    { gid: 'core:TRC-00011-1', source: 'core', name: 'song.flac', meta: '音频 · 38 MB', tab: 'done', pct: 100, line: '校验通过 · 完成于 11:42' },
    { gid: 'tg:29', source: 'tg', name: '摄影频道 Z · 九月合集', meta: '缓存任务 · 86 张图片', tab: 'done', pct: 100, line: '已归库 · 完成于 10:20' },
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
      var srcChip = j.source === 'tg' ? '<span class="chip cy">TG 缓存</span>' : '<span class="chip">引擎</span>';
      var stateChip = j.tab === 'running' ? '<span class="chip em">下载中</span>'
        : j.tab === 'paused' ? '<span class="chip am">已暂停</span>'
        : j.tab === 'failed' ? '<span class="chip ro">需处理</span>'
        : '<span class="chip">完成</span>';
      var bar = j.source === 'tg' ? 'background:linear-gradient(90deg,#38bdf8,#22d3ee)' : '';
      var actions;
      if (j.source === 'tg' && j.tab === 'running') actions = '<span class="no-act">运行中不可暂停（无真续传）</span>';
      else if (j.tab === 'failed') actions = '<button class="btn sm primary">整任务重试</button><button class="btn sm danger">删除</button>';
      else if (j.tab === 'running') actions = '<button class="btn sm">暂停</button><button class="btn sm">详情</button>';
      else if (j.tab === 'paused') actions = '<button class="btn sm primary">继续</button><button class="btn sm">详情</button>';
      else actions = '<button class="btn sm">定位文件</button><button class="btn sm">详情</button>';
      return '<div class="dl-row"><div class="dlic">' + dlTypeIcon(j.meta) + '</div>' +
        '<div class="dl-main"><div class="t1"><span class="idcode">' + j.gid + '</span> ' + j.name + ' ' + srcChip + stateChip + '</div>' +
        '<div class="progress"><i style="width:' + j.pct + '%;' + bar + '"></i></div>' +
        '<div class="t2"><span>' + j.meta + '</span><span>' + j.line + '</span></div></div>' +
        '<div class="dl-actions">' + actions + '</div></div>';
    }).join('') || '<div class="empty-hint">该筛选下没有任务</div>';

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
    var selCnt = document.getElementById('dl-selcnt');
    if (selCnt) selCnt.textContent = cnt[dlTab];
    ['running', 'paused', 'done'].forEach(function (k) {
      var nc = document.getElementById('nc-' + k);
      if (nc) nc.textContent = cnt[k];
    });
    var badge = document.getElementById('nav-dl-cnt');
    badge.textContent = cnt.running; badge.style.display = cnt.running ? '' : 'none';
  }
  var DL_NAMES = { all: '全部任务', running: '下载中', paused: '已暂停', done: '已完成' };
  function setDlTab(t) {
    dlTab = t;
    var n = document.getElementById('dl-selname');
    if (n) n.textContent = DL_NAMES[t];
    syncNav();
    renderDownloads();
    renderCtx();
    var nc2 = document.getElementById('dl-selcnt');
    if (nc2) nc2.textContent = document.querySelectorAll('#dl-list .dl-row').length;
  }
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

  /* ================= 全部文件：成品内容浏览器 ================= */
  function playIcon() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; }
  function audioIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>'; }
  function imageIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>'; }

  // 成品媒体（已完成下载 / 已入库 / 已导入；进行中任务绝不出现于此）
  var MEDIA = [
    { t: '演示片段 4K Demo', m: '视频 · 12′ · 482 MB', c: 'v', d: '12:03', src: 'TG', cat: 'video', series: false },
    { t: '城市夜景延时', m: '视频 · 3′06″ · 118 MB', c: 'v', d: '3:06', src: '导入', cat: 'video', series: true },
    { t: '纪录片 S02E03', m: '视频 · 52′ · 4.2 GB', c: 'v', d: '52:41', src: 'TG', cat: 'video', series: true, sname: '纪录片精选' },
    { t: '产品演示 2026', m: '视频 · 8′ · 260 MB', c: 'v', d: '8:12', src: '导入', cat: 'video', series: false },
    { t: '科幻短片 · 雾港', m: '视频 · 17′ · 920 MB', c: 'v', d: '17:20', src: '下载', cat: 'video', series: true, sname: '科幻短片季' },
    { t: '讲座录音 EP12', m: '音频 · 48′ · 46 MB', c: 'a', src: '导入', cat: 'audio', series: false },
    { t: '电影配乐合集', m: '音频 · 12 首 · 320 MB', c: 'a', src: 'TG', cat: 'audio', series: true, sname: '古典音乐会' },
    { t: '封面素材组', m: '图片 · 12 张 · 36 MB', c: 'p', src: 'TG', cat: 'image', series: false },
    { t: '旅行相册', m: '图片 · 86 张', c: 'p', src: '导入', cat: 'image', series: true, sname: '旅行 Vlog 合集' },
    { t: 'RAW 原片选集', m: '图片 · 240 张', c: 'p', src: 'TG', cat: 'image', series: false }
  ];
  var GLYPH = {
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 8h4M10 12h4M10 16h4"/></svg>',
    other: '<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>'
  };
  // 成品非媒体文件（完成的下载/导入；pdf/zip/字幕等）
  var NONMEDIA = [
    { g: 'doc', cat: 'doc', name: 'manual.pdf', sub: '完成于 昨天 · 下载来源', size: '3.4 MB', origin: '下载', otype: 'em' },
    { g: 'doc', cat: 'doc', name: '说明书扫描件.pdf', sub: '本地导入', size: '18 MB', origin: '导入', otype: '' },
    { g: 'archive', cat: 'archive', name: 'photo-batch.zip', sub: '完成于 周二 · 下载来源', size: '88 MB', origin: '下载', otype: 'em' },
    { g: 'archive', cat: 'archive', name: '素材包-2026Q3.zip', sub: '本地导入', size: '1.4 GB', origin: '导入', otype: '' },
    { g: 'other', cat: 'other', name: '纪录片-S02E03.zh.srt', sub: '随片字幕 · 已入库', size: '62 KB', origin: 'TG', otype: 'cy' },
    { g: 'warn', cat: 'other', name: 'old-deleted.mp4（缺失）', sub: '有条目但文件缺失（孤儿条目）', size: '—', origin: 'TG', otype: 'cy', act: '移除条目' }
  ];

  var fmode = 'cat-all', tagSel = null, sdSeries = null;

  function mediaCard(x, extraChip) {
    var icon = x.c === 'v' ? playIcon() : x.c === 'a' ? audioIcon() : imageIcon();
    return '<div class="mcard"><div class="thumb ' + x.c + '"><span class="badge-src">' + x.src + '</span>' +
      icon +
      (x.d ? '<span class="dur">' + x.d + '</span>' : '') +
      (extraChip || '') + '</div>' +
      '<div class="mc-body"><div class="mc-t">' + x.t + '</div><div class="mc-m"><span>' + x.m + '</span></div></div></div>';
  }
  function fileRow(f) {
    return '<div class="fact-row"><div class="fi" style="background:var(--panel-3)">' + GLYPH[f.g] + '</div>' +
      '<div class="fr-path">' + f.name + '<small>' + f.sub + '</small></div>' +
      '<span class="fr-size">' + f.size + '</span>' +
      '<span class="origin-tag">' + (f.otype ? '<span class="chip ' + f.otype + '">' + f.origin + '</span>' : '') + '</span>' +
      '<span>' + (f.act ? '<button class="btn sm danger">' + f.act + '</button>' : '<button class="btn sm">打开位置</button>') + '</span></div>';
  }
  function renderCat() {
    var cat = fmode.split('-')[1];
    var media = MEDIA.filter(function (x) { return cat === 'all' || x.cat === cat; });
    var files = NONMEDIA.filter(function (x) { return cat === 'all' || x.cat === cat; });
    document.getElementById('files-cards').innerHTML = media.length
      ? media.map(function (x) {
          var chip = !x.series ? '<span class="chip am unfiled-badge">未归档</span>' : '';
          return mediaCard(x, chip);
        }).join('')
      : '<div class="empty-hint">该分类下没有成品媒体</div>';
    var wrap = document.getElementById('files-nonmedia-wrap');
    wrap.style.display = files.length ? '' : 'none';
    document.getElementById('files-nonmedia').innerHTML = files.map(fileRow).join('');
  }

  var SERIES = ['纪录片精选', '科幻短片季', '摄影教程合集', '2026 新剧', '古典音乐会', '旅行 Vlog 合集', 'BBC 自然系列', '动画短篇'];
  function renderSeriesGrid() {
    document.getElementById('files-series-grid').innerHTML = SERIES.map(function (s, i) {
      return '<div class="mcard series-card" data-series="' + s + '"><div class="thumb v" style="background:linear-gradient(135deg,#1d2a3a,#13202c)">' + playIcon() +
        '<span class="dur">' + (6 + i) + ' 集</span></div><div class="mc-body"><div class="mc-t">' + s + '</div>' +
        '<div class="mc-m"><span>剧集 · 2026 · 点击管理成员</span></div></div></div>';
    }).join('');
  }
  document.getElementById('files-series-grid').addEventListener('click', function (e) {
    var card = e.target.closest('.series-card'); if (!card) return;
    openSeries(card.dataset.series);
  });

  var TAGS = ['4K', 'HEVC', '纪录片', '讲座', '合集', '待整理', '已归档', '音乐现场', '延时摄影', '中英字幕', '无损音频', '短视频', 'RAW', '精选'];
  function renderTags() {
    document.getElementById('files-tag-cloud').innerHTML = TAGS.map(function (t, i) {
      var cls = i % 4 === 0 ? 'em' : i % 4 === 1 ? 'cy' : '';
      var on = tagSel === t ? ' tag-on' : '';
      return '<button class="chip ' + cls + on + '" data-tag="' + t + '">#' + t + '</button>';
    }).join('');
    var lab = document.getElementById('files-tag-result-label');
    lab.style.display = tagSel ? '' : 'none';
    if (tagSel) {
      document.getElementById('files-tag-name').textContent = tagSel;
      // mock：标签结果集（真实实现为按 tag 过滤的成品内容查询）
      document.getElementById('files-tag-results').innerHTML = MEDIA.slice(0, 6).map(function (x) {
        return mediaCard(x, '<span class="chip cy tag-badge">#' + tagSel + '</span>');
      }).join('');
    } else {
      document.getElementById('files-tag-results').innerHTML = '';
    }
  }
  document.getElementById('files-tag-cloud').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    var t = b.dataset.tag;
    tagSel = tagSel === t ? null : t;
    renderTags();
  });

  function renderUnfiled() {
    var list = MEDIA.filter(function (x) { return !x.series; });
    document.getElementById('files-unfiled-grid').innerHTML = list.length
      ? list.map(function (x) { return mediaCard(x, '<span class="chip am unfiled-badge">未归档</span>'); }).join('')
      : '<div class="empty-hint">所有媒体都已归档</div>';
  }

  /* 剧集详情：成员管理（从剧集移除成员，不删字节/条目；BUG-112 图片入口在此） */
  var SD_MEMBERS = [];
  function openSeries(name) {
    sdSeries = name;
    SD_MEMBERS = MEDIA.filter(function (x) { return x.series; }).concat(MEDIA.slice(0, 2)).map(function (x, i) {
      return { key: name + '-' + i, x: x };
    });
    document.getElementById('sd-title').textContent = name;
    renderSd();
    renderFiles();
  }
  function renderSd() {
    document.getElementById('sd-sub').textContent = SD_MEMBERS.length + ' 个成员 · 移除只断开剧集归属，字节与条目保留（可在未归档重新归入）';
    document.getElementById('sd-members').innerHTML = SD_MEMBERS.map(function (m) {
      var card = mediaCard(m.x, '<button class="sd-remove" data-key="' + m.key + '" title="从剧集移除（不删除文件）">×</button>');
      return card.replace('class="mcard', 'class="mcard sd-member" data-key="' + m.key + '"');
    }).join('') || '<div class="empty-hint">该剧集还没有成员</div>';
  }
  document.getElementById('sd-members').addEventListener('click', function (e) {
    var b = e.target.closest('.sd-remove'); if (!b) return;
    SD_MEMBERS = SD_MEMBERS.filter(function (m) { return m.key !== b.dataset.key; });
    renderSd();
  });
  document.getElementById('sd-back').addEventListener('click', function () {
    sdSeries = null;
    renderFiles();
  });

  function setFmode(mode) {
    fmode = mode;
    sdSeries = null;
    tagSel = null;
    renderFiles();
  }
  function renderFiles() {
    ['pane-cat', 'pane-series', 'pane-tags', 'pane-unfiled', 'pane-series-detail'].forEach(function (id) {
      document.getElementById(id).style.display = 'none';
    });
    if (sdSeries) { document.getElementById('pane-series-detail').style.display = ''; renderSd(); syncNav(); renderCtx(); return; }
    if (fmode.indexOf('cat-') === 0) { document.getElementById('pane-cat').style.display = ''; renderCat(); }
    else if (fmode === 'lib-series') { document.getElementById('pane-series').style.display = ''; renderSeriesGrid(); }
    else if (fmode === 'lib-tags') { document.getElementById('pane-tags').style.display = ''; renderTags(); }
    else if (fmode === 'lib-unfiled') { document.getElementById('pane-unfiled').style.display = ''; renderUnfiled(); }
    syncNav(); renderCtx();
  }
  renderFiles();

  /* ================= TG：两级 source-browser ================= */
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
  document.getElementById('btn-go-download').addEventListener('click', function () { switchView('download', { dltab: 'all' }); });
  renderDialogs();

  /* ================= 全局状态：TG 启用 / 共享服务 ================= */
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

  /* ================= 设置分区 ================= */
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

  applyTg(); applyShare(); syncNav(); renderCtx();
})();
