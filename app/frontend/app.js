/* 看得懂的配料表，DeepEggy 前端逻辑
   零构建原生 JS。演示阶段数据来自 mock.js，接口对齐后替换 loadProduct()。 */

(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var LS_PREF = 'dg_prefs', LS_ALLERGY = 'dg_allergies', LS_HIST = 'dg_history_v2';
  var LS_HIST_OLD = 'dg_history';   // v1：存的是名字快照，含已下架的占位示例，只在迁移时读一次

  var PREF_TAGS = ['控糖', '减脂', '高血压', '糖尿病', '高尿酸/痛风', '乳糖不耐',
                   '肠胃敏感', '孕期', '给孩子买', '给长辈买', '素食', '过敏体质'];
  // 过敏原数据与匹配逻辑见 allergens.js（DG_ALLERGENS）：GB 7718-2025 的 14 类核心致敏物质 + 11 类其他致敏食物

  var state = {
    product: null,
    mode: 'barcode',
    stream: null,
    detector: null,
    scanTimer: null,
    tab: 'ing',
    view: 'viewHome',
    lastFrame: null
  };

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 结论文案统一为专业表述（来自队友前端规范）：不预设“买/不买”，给判断依据
  function verdictLabel(level) {
    if (level === 'bad') return '谨慎购买';
    if (level === 'caution') return '适量更合适';
    return '可按需选择';
  }

  function normalizeVerdict(p) {
    if (!p || !p.verdict) return p;
    if (['good', 'caution', 'bad'].indexOf(p.verdict.level) < 0) p.verdict.level = 'caution';
    p.verdict.label = verdictLabel(p.verdict.level);
    return p;
  }

  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function read(k, d) {
    try { var r = JSON.parse(localStorage.getItem(k)); return r == null ? d : r; } catch (e) { return d; }
  }
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  /* ---------------- 视图与返回 ---------------- */
  // 每进一屏，把「这一屏长什么样」压进浏览器历史：屏幕上的返回键、手机返回手势、Esc 都回得去。
  // 历史里存的是快照（哪一屏 + 哪个商品 + 哪个 tab），所以从 B 商品退回到 A 商品的搭配页也回得去。
  var navDepth = 0;    // 当前这条历史离入口页有几层，0 表示已经站在入口页
  var booting = true;  // 首屏（含深链接）只替换历史，不新增

  function snap() {
    return { view: state.view, product: state.product, tab: state.tab };
  }

  function hashOf(s) {
    var names = { viewHome: 'home', viewScan: 'scan', viewResult: 'result' };
    var h = '#' + (names[s.view] || 'home');
    if (s.view === 'viewResult' && s.product && s.product.id !== 'unknown') {
      h += '?p=' + encodeURIComponent(s.product.id) + '&t=' + s.tab;
    }
    return h;
  }

  // 地址栏跟上当前状态，但不新增历史（切 tab 用；分享给队友的链接也靠它）
  function syncHash() {
    var s = snap();
    history.replaceState({ dg: s, dgDepth: navDepth }, '', hashOf(s));
  }

  function updateBackBtn() {
    var b = $('#btnBack');
    if (!b) return;
    var show = state.view !== 'viewHome';
    b.hidden = !show;
    if (show) b.setAttribute('aria-label', state.view === 'viewResult' ? '返回上一屏' : '返回首页');
  }

  // 只切屏面，不动历史（返回还原时用）
  function paintView(id) {
    if (state.view === 'viewScan' && id !== 'viewScan') stopCamera();
    $$('.view').forEach(function (v) { v.hidden = v.id !== id; });
    $('#actionbar').hidden = (id !== 'viewResult');
    state.view = id;
    if (id === 'viewHome') loadProductIndex();
    updateBackBtn();
  }

  function showView(id, opts) {
    opts = opts || {};
    paintView(id);
    var s = snap();
    if (booting || opts.history === 'replace') {
      history.replaceState({ dg: s, dgDepth: navDepth }, '', hashOf(s));
    } else {
      navDepth += 1;
      history.pushState({ dg: s, dgDepth: navDepth }, '', hashOf(s));
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 从历史快照还原一屏（返回键、浏览器后退 / 前进都走这里）
  function restoreSnap(s) {
    if (!s) s = { view: 'viewHome', product: null, tab: 'ing' };
    // 取景屏是过程屏（相机 / 识别中），退回来落回首页，别留一个卡住的摄像头画面
    var view = s.view === 'viewScan' ? 'viewHome' : (s.view || 'viewHome');
    var p = s.product || null;
    var swapped = (p !== state.product);
    state.product = p;
    if (p && swapped) renderResult(p);
    paintView(view);
    if (view === 'viewResult') switchTab(s.tab || 'ing', true);
    syncHash();
  }

  var backPending = false;   // 连点返回只退一屏（history.back 是异步的）
  function goBack() {
    if (backPending) return;
    // navDepth > 0 时上一条历史一定是本页自己压的，可以放心后退；
    // 0 表示是直接打开 / 别人分享来的深链接，退回首页，而不是把用户送出站外
    if (navDepth > 0) {
      backPending = true;
      setTimeout(function () { backPending = false; }, 800);
      history.back();
    } else {
      showView('viewHome');
    }
  }

  window.addEventListener('popstate', function (e) {
    backPending = false;
    var st = e.state;
    navDepth = (st && typeof st.dgDepth === 'number') ? st.dgDepth : 0;
    restoreSnap(st && st.dg);
  });

  function routeFromHash() {
    // bare=1 只用于录屏和截图：藏起页面外壳，只留内容本身
    if (/[?&]bare/.test(location.hash)) document.documentElement.classList.add('shotmode');
    var kind = (location.hash.match(/^#([a-z]+)/i) || [])[1];
    if (kind === 'scan') {
      state.mode = 'barcode';
      showView('viewScan');
      startCamera();
      return true;
    }
    if (kind === 'prefs') {
      showView('viewHome');
      renderPrefs();
      openSheet($('#prefSheet'));
      return true;
    }
    if (kind === 'hotness') {
      // 深链接 /#hotness：直接摊开「热度怎么算的」，评委和用户都能自己看
      showView('viewHome');
      openHotness();
      return true;
    }
    var id = (location.hash.match(/[?&]p=([^&]+)/) || [])[1];
    if (!id) return;
    var tab = (location.hash.match(/[?&]t=([a-z]+)/i) || [])[1];
    var p = window.DEMO.list.filter(function (x) { return x.id === id; })[0];
    if (!p) return false;
    openResult(p, 'link');
    if (tab) switchTab(tab);
    if (kind === 'card') { drawCard(p); openSheet($('#shareSheet')); }
    return true;
  }
  var sheetReturn = null;
  function openSheet(el) {
    sheetReturn = document.activeElement;
    el.hidden = false;
    var f = $('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', el);
    if (f) f.focus();
  }
  function closeSheet(el) {
    el.hidden = true;
    if (sheetReturn && sheetReturn.focus) sheetReturn.focus();
    sheetReturn = null;
  }

  /* ---------------- 首页商品索引（后端全库 + 品类标签） ---------------- */
  var idx = { loaded: false, loading: false, all: [], tag: '全部', shown: 60 };
  var IDX_TAGS = ['热门', '全部', '水', '饮料', '乳制品', '茶咖', '薯片', '饼干', '糕点面包', '糖果巧克力', '方便食品', '坚果零食', '其他'];

  function loadProductIndex() {
    if (idx.loaded || idx.loading) return;
    idx.loading = true;
    var box = $('#idxList');
    if (box) box.innerHTML = '<div class="idx-tip">正在加载商品索引…</div>';
    fetchTimeout('/api/products', {}, 20000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        idx.all = (d && d.products) || [];
        idx.hotWords = (d && d.hotWords) || [];
        idx.loaded = true;
        $('#idxTotal').textContent = idx.all.length ? '共 ' + idx.all.length + ' 款' : '';
        renderIdxChips();
        renderHotWords();
        renderIdxList();
      })
      .catch(function () {
        if (box) box.innerHTML = '<div class="idx-tip">商品索引加载失败，可下拉刷新重试</div>';
      })
      .finally(function () { idx.loading = false; });
  }

  function idxFiltered() {
    if (idx.tag === '热门') return idx.all.filter(function (p) { return p.hot; });
    return idx.tag === '全部' ? idx.all : idx.all.filter(function (p) { return p.tag === idx.tag; });
  }

  // 实时热门零食词（联网抓的，点一下直接联网搜配料表）
  function renderHotWords() {
    var box = $('#idxHotWords');
    if (!box) return;
    var words = idx.hotWords || [];
    if (!words.length) { box.hidden = true; return; }
    box.innerHTML = '<span class="hot-label">🔥 网上在火：</span>' + words.map(function (w) {
      return '<button type="button" class="chip hot-word" data-w="' + esc(w) + '">' + esc(w) + '</button>';
    }).join('');
    box.hidden = false;
    $$('#idxHotWords .hot-word').forEach(function (b) {
      b.addEventListener('click', function () {
        analyzeBarcodeWeb({ name: b.dataset.w, brand: '' }, '', 'name');
      });
    });
  }

  function renderIdxChips() {
    var counts = {};
    idx.all.forEach(function (p) { counts[p.tag] = (counts[p.tag] || 0) + 1; });
    var hotCount = idx.all.filter(function (p) { return p.hot; }).length;
    $('#idxChips').innerHTML = IDX_TAGS.filter(function (t) {
      return t === '全部' || t === '热门' || counts[t];
    }).map(function (t) {
      var n = t === '全部' ? idx.all.length : (t === '热门' ? hotCount : counts[t]);
      if (t === '热门' && !n) return '';
      return '<button class="chip' + (t === idx.tag ? ' on' : '') + '" data-tag="' + esc(t) + '">' +
        (t === '热门' ? '🔥 ' : '') + esc(t) + '<span class="chip-n">' + n + '</span></button>';
    }).join('');
    $$('#idxChips .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        idx.tag = b.dataset.tag;
        idx.shown = 60;
        renderIdxChips();
        renderIdxList();
      });
    });
  }

  function renderIdxList() {
    var list = idxFiltered();
    var page = list.slice(0, idx.shown);
    $('#idxList').innerHTML = page.map(function (p) {
      var why = (p.hotWhy && p.hotWhy.length) ? ' title="热度依据：' + esc(p.hotWhy.join('；')) + '"' : '';
      return '<button class="demo-item" data-code="' + esc(p.code) + '"' + why + '>' +
        '<span class="n">' + (p.hot ? '🔥 ' : '') + esc(p.name) + '</span>' +
        '<span class="b' + (p.brand ? '' : ' tagonly') + '">' + esc(p.brand || p.tag) + '</span>' +
        '<span class="pill ' + (p.ing ? 'good' : 'none') + '">' + (p.ing ? '有配料表' : '联网查') + '</span>' +
        '</button>';
    }).join('') +
      (list.length > idx.shown
        ? '<button class="idx-more" id="idxMore">显示更多（还有 ' + (list.length - idx.shown) + ' 款）</button>'
        : '<div class="idx-tip">共 ' + list.length + ' 款，点一个看配料解读</div>');
    $$('#idxList .demo-item').forEach(function (b) {
      b.addEventListener('click', function () { openIndexed(b.dataset.code); });
    });
    var more = $('#idxMore');
    if (more) more.addEventListener('click', function () { idx.shown += 60; renderIdxList(); });
  }

  /* ---------------- 热度依据：把「为什么说它热门」摊开 ---------------- */
  var hnLoaded = false;
  function openHotness() {
    var sheet = $('#hotnessSheet');
    if (!sheet) return;
    openSheet(sheet);
    var srcBox = $('#hnSources'), topBox = $('#hnTop'), missBox = $('#hnMiss');
    if (hnLoaded || !srcBox) return;
    srcBox.innerHTML = '<p class="hn-loading">正在取热度数据…</p>';
    fetchTimeout('/api/hotness', {}, 20000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        hnLoaded = true;
        var intro = $('#hnIntro');
        if (intro && d.updated) intro.innerHTML = esc(intro.textContent) + ' <span class="hn-date">数据更新：' + esc(d.updated) + '</span>';
        srcBox.innerHTML = (d.sources || []).map(function (s) {
          var bad = /未抓取|没有|取不到|失败/.test(s.status || '');
          return '<div class="hn-src">' +
            '<span class="hn-nm">' + esc(s.name) + '</span>' +
            '<span class="hn-st ' + (bad ? 'off' : 'on') + '">' + esc(s.status || '—') + '</span>' +
            '<span class="hn-d">' + esc(s.detail || '') + '</span>' +
            '</div>';
        }).join('') || '<p class="hn-loading">暂时取不到来源信息</p>';
        topBox.innerHTML = (d.top || []).map(function (t, i) {
          return '<div class="hn-item">' +
            '<span class="hn-no">' + (i + 1) + '</span>' +
            '<span class="hn-tx"><b>' + esc(t.name || '') + '</b>' +
            '<span class="hn-why">' + esc((t.why || []).join('；') || '暂无依据') + '</span></span>' +
            '<span class="hn-score">' + Math.round(t.score || 0) + '</span>' +
            '</div>';
        }).join('') || '<p class="hn-loading">还没有算出热门商品</p>';
        var miss = (d.unavailable || []).map(function (u) { return u.name + '（' + u.reason + '）'; });
        missBox.innerHTML = miss.length ? '这些来源抓不到，如实标出来，不当成数据用：' + esc(miss.join('；')) : '';
        missBox.hidden = !miss.length;
      })
      .catch(function () {
        srcBox.innerHTML = '<p class="hn-loading">热度数据暂时取不到，稍后再试</p>';
      });
  }

  function openIndexed(code) {
    // 补充商品（extra-xxx）：无条码，直接取配料 → AI 解读
    if (String(code).indexOf('extra-') === 0) {
      toast('正在读取商品…');
      fetchTimeout('/api/product?code=' + encodeURIComponent(code), {}, 15000)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.found && d.product) {
            analyzeByText(d.product.ingredients, {
              name: d.product.name, brand: d.product.brand, category: d.product.tag
            }, 'index');
          } else {
            toast('商品数据读取失败');
          }
        })
        .catch(function () { toast('连不上后端，请稍后重试'); });
      return;
    }
    toast('正在读取商品 ' + code + '…');
    fetchTimeout('/api/scan-barcode?code=' + encodeURIComponent(code), {}, 15000)
      .then(function (r) { return r.json(); })
      .then(function (d) { handleScanResult(d, code, 'index'); })
      .catch(function () { toast('连不上后端，请稍后重试'); });
  }

  /* ---------------- 首页 ---------------- */
  function renderHome() {
    var box = $('#demoList');
    box.innerHTML = window.DEMO.list.map(function (p) {
      return '<button class="demo-item" data-id="' + esc(p.id) + '">' +
        '<span class="n">' + esc(p.name.split(' ')[0]) + '</span>' +
        '<span class="b">' + esc(p.spec) + '</span>' +
        '<span class="pill ' + esc(p.verdict.level) + '">' + esc(p.verdict.label) + '</span>' +
        '</button>';
    }).join('');
    $$('#demoList .demo-item').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = window.DEMO.list.filter(function (x) { return x.id === b.dataset.id; })[0];
        openResult(p, 'demo');
      });
    });
    renderHistory();
  }

  // v1 的历史存的是「当时那份名字快照」，示例商品一改名就变成旧名字留在列表里
  // （「某品牌 0 蔗糖乳茶」「维他命水 柠檬味（示例）」就是这么来的）。
  // 现在只存「是哪一款」，名字渲染时回查当前商品库；查不到的旧示例直接丢掉。
  function migrateHist() {
    var old = read(LS_HIST_OLD, null);
    if (old === null) return;
    var out = (Array.isArray(old) ? old : []).map(function (it) {
      var p = it && window.DEMO.lookup(it.code);
      return p ? { code: p.barcode, demo: true, name: p.name, at: it.at || '' } : null;
    }).filter(Boolean);
    store(LS_HIST, out);
    try { localStorage.removeItem(LS_HIST_OLD); } catch (e) {}
  }

  function histList() {
    migrateHist();
    var h = read(LS_HIST, []);
    var keep = h.filter(function (it) { return !it.demo || window.DEMO.lookup(it.code); });
    if (keep.length !== h.length) store(LS_HIST, keep);
    return keep;
  }

  function renderHistory() {
    var h = histList();
    $('#historyBox').hidden = !h.length;
    $('#historyList').innerHTML = h.map(function (it) {
      var p = window.DEMO.lookup(it.code);
      return '<button class="demo-item" data-code="' + esc(it.code) + '">' +
        '<span class="n">' + esc(p ? p.name : it.name) + '</span>' +
        '<span class="b">' + esc(it.at) + '</span><span class="go">回看</span></button>';
    }).join('');
    $$('#historyList .demo-item').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = window.DEMO.lookup(b.dataset.code);
        if (p) { openResult(p, 'history'); } else { toast('这条记录的演示数据已不在本机'); }
      });
    });
  }

  function pushHistory(p) {
    var h = histList().filter(function (x) { return x.code !== p.barcode; });
    var d = new Date();
    h.unshift({ code: p.barcode, demo: !!window.DEMO.lookup(p.barcode), name: p.name,
      at: (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) });
    store(LS_HIST, h.slice(0, 6));
  }

  /* ---------------- 相机 / 条码 ---------------- */
  var scanner = window.DeepEggyBarcode ? window.DeepEggyBarcode.createScanner() : null;
  var cameraSession = 0, lookupSession = 0, photoBusy = false, candidate = null, torchOn = false;

  function scanFeedback(message, isError) {
    var el = $('#barcodeFeedback');
    el.textContent = message || ''; el.hidden = !message;
    el.classList.toggle('error', !!isError);
    $('#codeInput').setAttribute('aria-invalid', isError ? 'true' : 'false');
  }

  async function startCamera() {
    stopCamera();
    lookupSession++;
    var session = ++cameraSession;
    scanFeedback('');
    // 每次重新开扫先把上一次的条码清掉：否则识别失败时，输入框里还留着上一个码，
    // 一点「查」就把上一次的商品又查出来，看起来像「扫了什么都是同一款」。
    if ($('#codeInput')) $('#codeInput').value = '';
    $('#btnRestartCamera').hidden = true;
    $('#cameraBadge').textContent = '正在开启相机';
    $('#scanTip').textContent = '正在请求相机，请在浏览器中允许使用。';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#cameraBadge').textContent = '相机不可用';
      $('#scanTip').textContent = '请在安全连接（HTTPS 或本机地址）中打开，或上传条码照片。';
      $('#btnRestartCamera').hidden = false;
      return;
    }
    try {
      var st;
      try {
        st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' },
          width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      } catch (e) {
        if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
        st = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      if (session !== cameraSession || state.view !== 'viewScan') {
        st.getTracks().forEach(function (t) { t.stop(); }); return;
      }
      state.stream = st;
      var track = st.getVideoTracks()[0], caps = track && track.getCapabilities ? track.getCapabilities() : {};
      if (track && caps.focusMode && caps.focusMode.indexOf('continuous') !== -1 && track.applyConstraints) {
        try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (_) {}
      }
      if (session !== cameraSession || state.stream !== st) { st.getTracks().forEach(function (t) { t.stop(); }); return; }
      $('#btnTorch').hidden = !(caps.torch && track && track.applyConstraints);
      var v = $('#cam'); v.srcObject = st; v.muted = true;
      await v.play();
      if (session !== cameraSession || state.stream !== st) return;
      $('#btnShoot').disabled = false;
      $('#cameraBadge').textContent = '相机已开启';
      $('#scanTip').textContent = scanner && scanner.available()
        ? '将完整条码放入框内，保持清晰并稍停片刻。'
        : '识别组件不可用，可手动输入商品条码。';
      if (track) track.onended = function () {
        if (session !== cameraSession) return;
        stopCamera(); $('#cameraBadge').textContent = '相机已关闭';
        $('#scanTip').textContent = '相机已关闭，可重新开启或上传照片。';
        $('#btnRestartCamera').hidden = false;
      };
      loopScan(session);
    } catch (e) {
      if (session !== cameraSession) return;
      stopCamera();
      $('#cameraBadge').textContent = '相机不可用';
      $('#scanTip').textContent = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        ? '相机权限未开启，请检查浏览器权限，或上传条码照片。'
        : '未能开启相机，可重试或上传条码照片。';
      $('#btnRestartCamera').hidden = false;
    }
  }

  function stopCamera() {
    cameraSession++; candidate = null; torchOn = false;
    clearTimeout(state.scanTimer); state.scanTimer = null;
    if (state.stream) { state.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); }); state.stream = null; }
    var v = $('#cam'); if (v) { v.pause(); v.srcObject = null; }
    if ($('#btnShoot')) $('#btnShoot').disabled = true;
    if ($('#btnTorch')) { $('#btnTorch').hidden = true; $('#btnTorch').setAttribute('aria-pressed', 'false'); $('#btnTorch').textContent = '打开闪光灯'; }
  }

  function grabFrame(maxWidth, target) {
    var v = $('#cam');
    if (!v.videoWidth || !v.videoHeight) return null;
    var c = target || document.createElement('canvas');
    var scale = Math.min(1, (maxWidth || 1920) / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.max(1, Math.round(v.videoWidth * scale)); c.height = Math.max(1, Math.round(v.videoHeight * scale));
    var ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return c;
  }

  function measureLight() {
    var c = grabFrame(320, $('#probe'));
    if (!c) return;
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var sum = 0, n = 0;
    for (var i = 0; i < d.length; i += 16) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++;
    }
    var pct = Math.max(0, Math.min(100, Math.round(sum / n / 1.9)));
    var f = $('#lightFill');
    f.style.transform = 'scaleX(' + (pct / 100).toFixed(3) + ')';
    f.className = pct < 28 ? 'bad' : pct < 45 ? 'warn' : 'good';
    $('#lightTxt').textContent = pct < 28 ? '偏暗' : pct < 45 ? '一般' : '充足';
    $('#lightNotice').hidden = pct >= 28;
  }

  function loopScan(session) {
    clearTimeout(state.scanTimer);
    var ticks = 0;
    var tick = async function () {
      if (session !== cameraSession || !state.stream || state.view !== 'viewScan') return;
      if (!photoBusy && document.activeElement !== $('#codeInput') && scanner && $('#cam').readyState >= 2) {
        try {
          if (++ticks % 3 === 0) measureLight();
          var videoTime = $('#cam').currentTime, result = await scanner.detect($('#cam'), false), now = Date.now();
          if (session !== cameraSession || !state.stream) return;
          if (!photoBusy && result) {
            if (candidate && candidate.code === result.code && now - candidate.at < 3000 && videoTime !== candidate.videoTime) {
              acceptDetected(result); return;
            }
            candidate = { code: result.code, at: now, videoTime: videoTime };
            $('#scanTip').textContent = '已读取，正在再次核对，请保持不动。';
          } else if (candidate && now - candidate.at > 3000) {
            candidate = null; $('#scanTip').textContent = '将完整条码放入框内，保持清晰并稍停片刻。';
          }
        } catch (_) { /* 某帧无法解码时继续尝试。 */ }
      }
      if (session === cameraSession && state.stream) state.scanTimer = setTimeout(tick, 420);
    };
    state.scanTimer = setTimeout(tick, 250);
  }

  async function inspectBarcodeImage(source) {
    if (!scanner || !scanner.available()) throw new Error('识别组件不可用，请手动输入条码。');
    return scanner.detect(source, true);
  }

  function acceptDetected(result) {
    if (!result.needsConfirmation) { onCodeFound(result.code); return; }
    stopCamera();
    $('#codeInput').value = result.code;
    $('#cameraBadge').textContent = '条码待核对';
    $('#scanTip').textContent = '请核对包装上的数字，再点查询。';
    $('#btnRestartCamera').hidden = false;
    scanFeedback('识别到 ' + result.code + '，请核对后点击查询。');
    $('#codeInput').focus();
  }

  function scanLookupMiss(message) {
    if (state.view === 'viewScan' && state.mode === 'barcode') {
      scanFeedback(message, true); $('#cameraBadge').textContent = '相机已关闭';
      $('#scanTip').textContent = '可核对数字、重新扫码，或拍配料表继续。';
      $('#btnRestartCamera').hidden = false;
    } else toast(message, 3500);
  }

  function onCodeFound(code) {
    stopCamera();
    var requestId = ++lookupSession;
    $('#codeInput').value = code;
    scanFeedback('已读取 ' + code + '，正在查询…');
    $('#cameraBadge').textContent = '已读取条码';
    $('#scanTip').textContent = '正在查找商品信息。';
    // 扫到的码只认后端条码库：本地示例（demoOnly）一律不参与扫码，
    // 这样示例怎么改版都不会盖到真实条码上。
    fetchTimeout('/api/scan-barcode?code=' + encodeURIComponent(code), {}, 15000)
      .then(function (r) { return r.json(); })
      .then(function (d) { if (requestId === lookupSession && state.view === 'viewScan') handleScanResult(d, code); })
      .catch(function () {
        if (requestId === lookupSession && state.view === 'viewScan') scanLookupMiss('查询服务暂时不可用，请重试或拍配料表。');
      });
  }

  // 后端条码查询结果 → 走对应解读路径（扫码命中 / 首页商品索引点击共用）
  function handleScanResult(d, code, via) {
    via = via || 'barcode';
    if (d && d.found && d.product) {
      var prod = d.product;
      // 内置示例商品（带 id）：只有「条码对得上、而且不是示例数据」才用本地补全。
      // 示例（demoOnly）永远不参与扫码，避免示例改版后扫 A 出 B。
      if (d.source === 'builtin' && prod.id) {
        var local = window.DEMO.list.filter(function (x) {
          return !x.demoOnly && x.barcode === code;
        })[0];
        if (local) { toast('条码 ' + code + ' 已匹配'); openResult(local, via); return; }
      }
      // OpenFoodFacts 商品：有配料表直接 AI 解读（带上它的品类，让 AI 按品类给指标）
      if (prod.ingredients && prod.ingredients.length >= 4) {
        toast('找到商品：' + (prod.name || code) + '，AI 正在解读配料表…');
        analyzeByText(prod.ingredients, {
          name: prod.name || '',
          brand: prod.brand || '',
          category: prod.categories || ''
        }, via);
        return;
      }
      // 联网查到商品身份（编码中心备案 / OFF 在线）但没有配料表 → 联网搜配料表再解读
      if (prod.name) {
        toast('联网找到商品：' + prod.name + '，正在查配料表…');
        analyzeBarcodeWeb(prod, code, via);
        return;
      }
      toast('找到条码但商品信息不全，请拍配料表');
      startLabelFlow(null);
      return;
    }
    toast('条码 ' + code + ' 未收录，改走「拍配料表」');
    startLabelFlow(null);
  }

  // 扫码联网解读：商品身份已确认（名称/品牌/规格），后端搜配料表 → AI 解读；失败回退拍配料表
  function analyzeBarcodeWeb(prod, code, via) {
    showBusy('已找到 ' + (prod.name || code) + '，AI 正在联网查配料表…');
    return busyFetch('/api/analyze-barcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code || '',
        name: prod.name || '',
        brand: prod.brand || '',
        category: prod.category || prod.categories || '',
        spec: prod.spec || ''
      })
    }, 180000).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.verdict && d.ingredients) { openResult(d, via || 'barcode'); }
        else { toast('联网没找到可靠配料表：' + ((d && d.error) || '换个方式，请拍配料表')); startLabelFlow(null); }
      })
      .catch(function () {
        if (busyCanceled) return;   // 用户自己点了「返回」，别再说"网络问题"
        toast('联网解读失败（网络问题），改走拍配料表'); startLabelFlow(null);
      })
      .finally(function () { hideBusy(); });
  }

  // 用一段配料表文字走 AI 解读（扫码命中 / 拍照自动提取共用）
  function analyzeByText(text, meta, via) {
    meta = meta || {};
    if (!text || !String(text).replace(/\s/g, '').length) {
      toast('没有配料表内容，先拍一张或手动输入');
      return Promise.resolve();
    }
    showBusy('AI 正在读懂这份食品配料…');
    return busyFetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ocrText: text,
        name: meta.name || '',
        brand: meta.brand || '',
        category: meta.category || '',
        allergens: read(LS_ALLERGY, [])
      })
    }, 180000).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.verdict && d.ingredients) { openResult(d, via || 'label'); }
        else { toast('AI 解读失败：' + ((d && d.error) || '未知错误')); }
      })
      .catch(function () {
        if (busyCanceled) return;   // 用户自己点了「返回」
        toast('AI 解读失败（网络问题）');
      })
      .finally(function () { hideBusy(); });
  }

  // 带超时的 fetch（避免请求卡住一直转圈）；传 signal 就能被「返回」提前中断
  function fetchTimeout(url, opts, ms, signal) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 30000);
    opts = opts || {};
    opts.signal = ctrl.signal;
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
    }
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  /* ---------------- 处理中遮罩 ---------------- */
  // 联网查太久时，遮罩里浮出「继续等 / 返回」：等不到结果的用户不该被一直卡在转圈上。
  var BUSY_ESCAPE_MS = 8000;        // 超过这么久还没回来，就先给出出口
  var BUSY_ESCAPE_AGAIN_MS = 20000; // 点了「继续等」之后再等这么久，出口重新出现
  var busyEscapeTimer = null;
  var busyCtrl = null;      // 这次「处理中」对应的请求，点「返回」时一起中断
  var busyCanceled = false; // 用户主动点了「返回」：各流程的 catch 别再把这次当网络错误报

  // 处理中发出的请求（中断器登记在 busyCtrl，供「返回」使用）
  function busyFetch(url, opts, ms) {
    var ctrl = new AbortController();
    busyCtrl = ctrl;
    return fetchTimeout(url, opts, ms, ctrl.signal);
  }

  function armBusyEscape(ms) {
    var esc = $('#busyEsc');
    clearTimeout(busyEscapeTimer);
    if (esc) esc.hidden = true;
    busyEscapeTimer = setTimeout(function () {
      var b = $('#busy');
      if (!b || b.hidden) return;
      var e = $('#busyEsc');
      if (e) e.hidden = false;
    }, ms);
  }

  // 全屏处理中遮罩；ms 之后浮出「继续等 / 返回」
  function showBusy(msg, opts) {
    opts = opts || {};
    var b = $('#busy');
    if (!b) return;
    var t = $('#busyTxt');
    if (t) t.textContent = msg || '处理中…';
    busyCanceled = false;
    b.hidden = false;
    armBusyEscape(opts.escapeMs || BUSY_ESCAPE_MS);
  }

  function hideBusy() {
    var b = $('#busy');
    if (b) b.hidden = true;
    var esc = $('#busyEsc');
    if (esc) esc.hidden = true;
    clearTimeout(busyEscapeTimer);
    busyCtrl = null;
  }

  // 点「返回」：中断这次请求，收尾留给各流程的 catch（它看 busyCanceled 就知道别报错）
  function escapeBusy() {
    var b = $('#busy');
    if (!b || b.hidden) return;
    busyCanceled = true;
    var ctrl = busyCtrl;
    hideBusy();
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    // 取景屏的相机在开始查的时候就已经停了，留在那儿是个不会动的画面 → 退回首页
    if (state.view === 'viewScan') showView('viewHome', { history: 'replace' });
    toast('已停止查询，可以换个方式再查，或稍后再试', 3200);
  }

  /* ---------------- 拍配料表 ---------------- */
  function startLabelFlow(file) {
    state.mode = 'label';
    if (!file) {
      // 没有文件（如扫码未收录）：直接打开后置相机，拍完后会再进来。
      showView('viewHome');
      var inp = $('#cameraInput');
      if (inp) inp.click();
      return;
    }
    showView('viewScan');
    $('#scanMode').style.display = 'none';
    $('#scanTip').textContent = '识别中…';
    fileToBase64(file, function (b64) {
      if (!b64) { toast('图片读取失败，请重试'); showView('viewHome'); return; }
      showBusy('正在识别配料表…');
      busyFetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: b64 })
      }, 60000).then(function (r) {
        if (r.status === 501) {
          // 保留后端给出的具体原因（如"图片没认到清晰文字"）
          return r.json().then(function (d) { d.ocr_off = true; return d; }).catch(function () { return { ocr_off: true }; });
        }
        return r.json();
      }).then(function (d) {
        if (d && d.text) {
          // OCR 原文不展示给用户；后端会先截取配料区，再匹配本地配料库。
          return analyzeByText(d.text, {}, 'label');
        } else if (d && d.ocr_off) {
          var why = (d && d.error) ? String(d.error).replace(/^OCR 不可用：/, '') : '';
          toast(why ? ('识别暂时不可用：' + why.slice(0, 80)) : '识别服务暂时不可用，请稍后重试');
        } else {
          toast('识别失败：' + ((d && d.error) || '未知错误'));
        }
      }).catch(function () {
        if (busyCanceled) return;   // 用户自己点了「返回」
        toast('连不上后端，请检查网络后重试');
      }).finally(function () {
        hideBusy();
        if (state.view === 'viewScan') showView('viewHome');
      });
    });
  }

  // 图片压缩并转 base64（长边 ≤1600、JPEG 0.85，省流量也防超大图）
  function fileToBase64(file, cb) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var max = 1600, w = img.width, h = img.height;
      if (Math.max(w, h) > max) {
        var k = max / Math.max(w, h);
        w = Math.round(w * k); h = Math.round(h * k);
      }
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      try { cb(cv.toDataURL('image/jpeg', 0.85).split(',')[1]); } catch (e) { cb(''); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(''); };
    img.src = url;
  }

  /* ---------------- 结果 ---------------- */
  function openResult(p, via) {
    normalizeVerdict(p);   // 结论文案统一为专业表述（谨慎购买/适量更合适/可按需选择）
    p.__via = via || 'label';
    state.product = p;
    state.tab = 'ing';
    renderResult(p);
    if (p.barcode !== '未采集') { pushHistory(p); renderHistory(); }
    showView('viewResult');   // 压一条历史：返回键 / 手机返回手势都能回到来时的这一屏
    switchTab('ing');
    if (via === 'demo') toast('示例数据，仅供演示');
  }

  // 品名来源标注：拍配料表时品名是「从包装上读的」还是「AI 判断的」，卡片上要说清楚
  var NAME_SOURCE_HINT = {
    'label': '品名读自包装',
    'label-inferred': '品名读自包装 · 可能不准',
    'model': '品名由 AI 判断',
    'none': '照片里没拍到商品名'
  };

  function renderResult(p) {
    var srcHint = NAME_SOURCE_HINT[p.nameSource];
    $('#rBrand').textContent = srcHint ? (p.brand + ' · ' + srcHint) : p.brand;
    $('#rName').textContent = p.name;
    $('#rSpec').textContent = p.spec + '，' + p.category;
    $('#rCode').textContent = p.barcode;

    // 这张卡的结果是从哪来的，写在脸上：扫码 / 拍照 / 示例 / 索引 / 历史
    var from = $('#rFrom');
    if (from) {
      var via = p.__via || '';
      var text = '';
      if (via === 'demo') text = '示例数据 · 仅供演示，不是识别结果';
      else if (via === 'barcode') text = '扫码识别' + (p.barcode && p.barcode !== '未采集' ? ' · 条码 ' + p.barcode : '');
      else if (via === 'label') text = '拍照识别 · 来自配料表照片';
      else if (via === 'history') text = '历史记录';
      else if (via === 'index') text = '商品索引 · 库内商品';
      else if (via === 'name') text = '按商品名联网查询 · 未经条码确认';
      else if (via === 'link') text = '分享链接打开';
      else text = '识别结果';
      from.textContent = text;
      from.hidden = !text;
      from.className = 'rc-from' + (via === 'demo' ? ' demo' : '');
    }

    var st = $('#rStamp');
    st.className = 'stamp ' + p.verdict.level;
    $('#rStampTxt').textContent = p.verdict.label;
    $('#rWhy').textContent = p.verdict.why;

    $('#rKeys').innerHTML = p.keys.map(function (k) {
      return '<div class="key' + (k.hi ? ' hi' : '') + '"><div class="v">' + esc(k.v) + '</div>' +
        '<div class="u">' + esc(k.u) + '</div><div class="l">' + esc(k.l) + '</div></div>';
    }).join('');

    renderIngredients(p);
    renderNutrition(p);
    renderPair(p);
    renderBuzz(p);
    renderTrace(p);
    renderTricks(p);
    renderYou(p);
  }

  /* ---------------- 成分释义：两种呈现 ----------------
     结构（默认）：按功能分组 + 原序序号 + 复合配料括号展开（逻辑见 ingredient-tree.js）
     顺序列表：改动前的平铺视图，保留作为对照与回退
     两者共用同一份 .ing 行渲染与详情内容，切换只换排布，不换数据。 */
  var LS_ING_VIEW = 'dg_ing_view';

  function ingView() {
    try {
      return localStorage.getItem(LS_ING_VIEW) === 'flat' ? 'flat' : 'tree';
    } catch (e) { return 'tree'; }
  }

  function ingToolbarHtml(mode) {
    var isTree = mode === 'tree';
    return '<div class="ing-bar">' +
      '<div class="sect-t">' + (isTree ? '按功能分组，序号是配料表原序' : '按配料顺序，点一行看详情') + '</div>' +
      '<div class="ing-seg" role="group" aria-label="配料呈现方式">' +
      '<button type="button" data-ingview="tree" aria-pressed="' + isTree + '"' + (isTree ? ' class="on"' : '') + '>结构</button>' +
      '<button type="button" data-ingview="flat" aria-pressed="' + (!isTree) + '"' + (!isTree ? ' class="on"' : '') + '>顺序列表</button>' +
      '</div></div>';
  }

  function ingDoseHtml(it) {
    if (!it.dose) { return ''; }
    return '<div class="dose"><div class="dose-t">这一份里的量 vs 每日参考</div>' +
      '<div class="dose-n"><b>' + esc(it.dose.amount) + '</b><span>／上限 ' + esc(it.dose.limit) + '</span></div>' +
      (it.dose.pct ? '<div class="dose-bar"><i class="' + (it.dose.bar || 'good') + '" style="transform:scaleX(' +
        (Math.min(100, it.dose.pct) / 100).toFixed(3) + ')"></i></div>' : '') +
      (it.dose.pct ? '<div class="dose-c">占上限 <b class="mono">' + it.dose.pct + '%</b>，' + esc(it.dose.note) + '</div>'
                   : '<div class="dose-c">' + esc(it.dose.note) + '</div>') +
      '</div>';
  }

  function ingRelHtml(p, it) {
    var rel = (window.DEMO ? window.DEMO.list : []).filter(function (o) {
      return o.id !== p.id && (o.ingredients || []).some(function (oi) {
        return oi.name.replace(/\s+/g, '') === String(it.name).replace(/\s+/g, '');
      });
    });
    return '<div class="rel"><span class="rel-l">同含这项</span>' +
      (rel.length ? rel.map(function (o) {
        return '<button type="button" class="rel-p" data-pid="' + esc(o.id) + '">' + esc(o.brand) + '</button>';
      }).join('') : '<span class="rel-none">库内只有这款含它（示例库共 ' + (window.DEMO ? window.DEMO.list.length : 0) + ' 款）</span>') + '</div>';
  }

  // 复合配料的括号展开项：只有包装原文里真写了括号才有，词条没有的明说未收录
  function ingSubsHtml(subs) {
    if (!subs || !subs.length || !window.DG_ING_TREE) { return ''; }
    return window.DG_ING_TREE.subsHtml(subs);
  }

  function ingItemHtml(p, it, i, opts) {
    opts = opts || {};
    var children = opts.children || [];
    var hasBody = true;
    var idx = opts.idx == null ? '' : '<span class="idx mono" aria-hidden="true">' + opts.idx + '</span>';
    return '<div class="ing" data-i="' + i + '">' +
      '<button class="ing-h" aria-expanded="false" aria-controls="ingBody' + i + '">' +
      '<span class="bul ' + esc(it.flag || 'green') + '"></span>' +
      '<span class="nm">' + idx + esc(it.name) + '</span>' +
      '<span class="role">' + esc(opts.role == null ? (it.role || '') : opts.role) + '</span>' +
      '<span class="car" aria-hidden="true"></span></button>' +
      '<div class="ing-b" id="ingBody' + i + '">' +
      '<div class="what">' + esc(it.what || '这一项还没有释义。') + '</div>' +
      (it.why ? '<div class="why">' + esc(it.why) + '</div>' : '') +
      (opts.note ? '<div class="why">包装标注：' + esc(opts.note) + '</div>' : '') +
      ingSubsHtml(children) +
      ingDoseHtml(it) +
      (it.caution ? '<div class="cau"><b>留意</b>' + esc(it.caution) + '</div>' : '') +
      ingRelHtml(p, it) +
      '</div></div>';
  }

  function ingNoteHtml(p, model) {
    var note = p.ingNote || '顺序即含量顺序：排在前面的占比大，排在后面的通常不到 2%。';
    var extra = '';
    if (model) {
      extra = '　分组来自团队 143 条审校词条，词条没有的进「未归类」；子配料只在包装括号里写了才展开。';
      if (model.stats.unknown) { extra += '本品 ' + model.stats.unknown + ' 项未归类，未归类不代表不安全。'; }
    }
    return '<div class="note">' + esc(note + extra) + '</div>';
  }

  function openFirstIng() {
    var first = $('#pIng .ing');
    if (first) {
      first.classList.add('open');
      $('.ing-h', first).setAttribute('aria-expanded', 'true');
    }
  }

  // 两种视图共用的事件绑定：行展开、同含跳转、分组折叠、视图切换
  function bindIngRows() {
    $$('#pIng .ing-h').forEach(function (h) {
      h.addEventListener('click', function () {
        var open = h.parentNode.classList.toggle('open');
        h.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
    $$('#pIng .rel-p').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = window.DEMO.list.filter(function (o) { return o.id === b.dataset.pid; })[0];
        if (t) openResult(t, 'link');
      });
    });
    $$('#pIng .igrp-h').forEach(function (h) {
      h.addEventListener('click', function () {
        var open = h.getAttribute('aria-expanded') === 'true';
        h.setAttribute('aria-expanded', String(!open));
        var car = h.querySelector('.car');
        if (car) { car.classList.toggle('open', !open); }
        var body = document.getElementById(h.getAttribute('aria-controls'));
        if (body) { body.hidden = open; }
      });
    });
    $$('#pIng [data-ingview]').forEach(function (b) {
      b.addEventListener('click', function () {
        try { localStorage.setItem(LS_ING_VIEW, b.dataset.ingview); } catch (e) { /* 无痕模式下忽略 */ }
        if (state.product) { renderIngredients(state.product); }
      });
    });
  }

  function renderIngredientsFlat(p) {
    $('#pIng').innerHTML = ingToolbarHtml('flat') +
      p.ingredients.map(function (it, i) {
        var dose = it.dose ? '<div class="dose"><div class="dose-t">这一份里的量 vs 每日参考</div>' +
          '<div class="dose-n"><b>' + esc(it.dose.amount) + '</b><span>／上限 ' + esc(it.dose.limit) + '</span></div>' +
          (it.dose.pct ? '<div class="dose-bar"><i class="' + (it.dose.bar || 'good') + '" style="transform:scaleX(' +
            (Math.min(100, it.dose.pct) / 100).toFixed(3) + ')"></i></div>' : '') +
          (it.dose.pct ? '<div class="dose-c">占上限 <b class="mono">' + it.dose.pct + '%</b>，' + esc(it.dose.note) + '</div>'
                       : '<div class="dose-c">' + esc(it.dose.note) + '</div>') +
          '</div>' : '';
        var rel = window.DEMO.list.filter(function (o) {
          return o.id !== p.id && o.ingredients.some(function (oi) {
            return oi.name.replace(/\s+/g, '') === it.name.replace(/\s+/g, '');
          });
        });
        var relHtml = '<div class="rel"><span class="rel-l">同含这项</span>' +
          (rel.length ? rel.map(function (o) {
            return '<button type="button" class="rel-p" data-pid="' + esc(o.id) + '">' + esc(o.brand) + '</button>';
          }).join('') : '<span class="rel-none">库内只有这款含它（示例库共 ' + window.DEMO.list.length + ' 款）</span>') + '</div>';
        return '<div class="ing" data-i="' + i + '">' +
          '<button class="ing-h" aria-expanded="false" aria-controls="ingBody' + i + '"><span class="bul ' + esc(it.flag) + '"></span>' +
          '<span class="nm">' + esc(it.name) + '</span><span class="role">' + esc(it.role || '') + '</span>' +
          '<span class="car" aria-hidden="true"></span></button>' +
          '<div class="ing-b" id="ingBody' + i + '"><div class="what">' + esc(it.what) + '</div>' +
          (it.why ? '<div class="why">' + esc(it.why) + '</div>' : '') +
          dose +
          (it.caution ? '<div class="cau"><b>留意</b>' + esc(it.caution) + '</div>' : '') +
          relHtml +
          '</div></div>';
      }).join('') +
      '<div class="note">' + esc(p.ingNote || '顺序即含量顺序：排在前面的占比大，排在后面的通常不到 2%。') + '</div>';

    bindIngRows();
    openFirstIng();
  }

  /* 结构视图：分组 → 配料（带原序序号）→ 复合配料子项 */
  function renderIngredientsTree(p) {
    var model = (window.DG_ING_TREE && (p.ingredients || []).length)
      ? window.DG_ING_TREE.build(p) : null;
    if (!model || !model.groups.length) { renderIngredientsFlat(p); return; }

    var html = ingToolbarHtml('tree') + '<div class="ing-tree">';
    model.groups.forEach(function (g, gi) {
      var open = gi === 0;
      var bodyId = 'igrpB' + gi;
      html += '<section class="igrp">' +
        '<button type="button" class="igrp-h" aria-expanded="' + open + '" aria-controls="' + bodyId + '">' +
        '<span class="car' + (open ? ' open' : '') + '" aria-hidden="true"></span>' +
        '<span class="igrp-n">' + esc(g.label) + '</span>' +
        '<span class="igrp-c mono">' + g.rows.length + '</span>' +
        '<span class="igrp-why">' + esc(g.note) + '</span>' +
        '</button>' +
        '<div class="igrp-b" id="' + bodyId + '"' + (open ? '' : ' hidden') + '>' +
        g.rows.map(function (r) {
          return ingItemHtml(p, r.item, r.index, {
            idx: r.index + 1,
            role: r.role,
            children: r.children,
            note: r.note
          });
        }).join('') +
        '</div></section>';
    });
    html += '</div>' + ingNoteHtml(p, model);

    $('#pIng').innerHTML = html;
    bindIngRows();
    openFirstIng();
  }

  function renderIngredients(p) {
    if (ingView() === 'tree' && window.DG_ING_TREE) { renderIngredientsTree(p); }
    else { renderIngredientsFlat(p); }
  }

  function renderNutrition(p) {
    var nuts = p.nutrition || [], eqs = p.equiv || [];
    $('#pNut').innerHTML = '<div class="sect-t">营养成分表：每 100g/mL，以及整份折算</div>' +
      (nuts.length ? nuts.map(function (n) {
        return '<div class="nrow' + (n.hi ? ' hi' : '') + '"><div class="top">' +
          '<span class="nm">' + esc(n.name) + '</span><span class="val">' + esc(n.per100) + '，整份 ' + esc(n.whole) + '</span>' +
          '<span class="nrv">' + (n.nrv ? n.nrv + '%' : '未标') + '</span></div>' +
          '<div class="nbar"><i class="' + (n.hi ? 'bad' : 'good') + '" style="transform:scaleX(' + (Math.min(100, n.nrv || 0) / 100).toFixed(3) + ')"></i></div>' +
          '<div class="cm">' + esc(n.cm) + '</div></div>';
      }).join('') : '<div class="you-empty">这次没取到营养成分表数字，不猜，只按配料表说。</div>') +
      (nuts.length ? '<div class="note">百分比为 NRV%，指一份占每日参考摄入量的比例，不是「健康程度」。</div>' : '') +
      (eqs.length ? '<div class="equv">' + eqs.map(function (e) {
        return '<div class="eq"><b>' + esc(e.big) + '</b>' + esc(e.small) + '</div>';
      }).join('') + '</div>' : '');
  }

  function renderTrace(p) {
    var t = p.trace;
    var c = p.compare;
    if (!t) {
      $('#pTrace').innerHTML = '<div class="sect-t">溯源，联网检索</div>' +
        '<div class="trace"><div class="st"><span class="ok">正在检索</span>' +
        '<span class="src-line">包装标注与公开渠道</span></div>' +
        '<div class="note" id="traceLiveNote">正在请求后端联网溯源…</div></div>';
      fetchTraceBackend(p);
      return;
    }
    $('#pTrace').innerHTML = '<div class="sect-t">溯源，联网搜官网</div>' +
      '<div class="trace' + (t.found ? '' : ' miss') + '">' +
      '<div class="st">' + (t.found ? '<span class="ok">官网可查</span>' : '<span class="no">官网无数据</span>') +
      '<span class="src-line">' + esc(t.source) + '</span></div>' +
      '<div class="pl">' + esc(t.place) + '</div>' +
      '<ul class="lns">' + (t.lines || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
      '<div class="src">' + esc(t.note) + '</div></div>' +
      (t.found ? '' : '<div class="note">溯源取不到数据时，本页结论只基于配料表与营养成分表，不做产地判断：宁可少说，不编。</div>') +
      renderCompare(c) +
      '<div class="note" id="traceLiveNote">正在请求后端联网溯源…</div>';
    fetchTraceBackend(p);
  }

  // 请求后端溯源（同源 /api/trace），结果回来后覆盖本页
  function fetchTraceBackend(p) {
    if (p._traceTried) return;
    p._traceTried = true;
    var body = {
      name: p.name, brand: p.brand || '',
      category: p.category || '', spec: p.spec || '',
      ocrText: p.ocrText || ('配料：' + (p.ingredients || []).map(function (i) { return i.name; }).join('、')),
      live: true
    };
    fetchTimeout('/api/trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 90000).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.identity && d.nodes) renderTraceBackend(p, d, p.compare);
      })
      .catch(function () {
        var n = $('#traceLiveNote');
        if (n) n.textContent = '后端暂不可用（连不上 /api/trace，不做联网结论）。';
      });
  }

  function renderCompare(c) {
    if (!c) return '';
    return '<div class="cmp"><div class="sect-t">同类对比：' + esc(c.metric) + '</div>' +
      c.rows.map(function (r) {
        var max = Math.max.apply(null, c.rows.map(function (x) { return x.value; })) || 1;
        return '<div class="cmp-row' + (r.me ? ' me' : '') + '"><span class="cn">' + esc(r.name) + '</span>' +
          '<span class="cb"><i style="transform:scaleX(' + (Math.round(r.value / max * 100) / 100).toFixed(3) + ')"></i></span>' +
          '<span class="cv">' + r.value.toFixed(1) + '</span></div>';
      }).join('') +
      '<div class="note">同类数据来自演示库，接后端后按知识库实时检索。</div></div>';
  }

  function renderTraceBackend(p, d, c) {
    var confMap = { proven: '已证实', probable: '待核验', unverified: '未核实', unknown: '查不到' };
    var badge = function (conf) { return '<i class="k">' + (confMap[conf] || esc(conf)) + '</i>'; };
    var id = d.identity || {};
    var html = '<div class="sect-t">溯源，联网检索（后端实时）</div>' +
      '<div class="trace">' +
      '<div class="st"><span class="ok">后端已联网检索</span>' +
      '<span class="src-line">识别：' + esc(id.name || p.name) + '</span></div>' +
      '<div class="pl">生产主体：' + esc((id.label_producers || []).join('、') || '包装未标注') + '</div>' +
      (id.std_nos && id.std_nos.length ? '<div class="pl">标准号：' + esc(id.std_nos.join('、')) + '</div>' : '') +
      ((d.nodes || []).map(function (node) {
        return '<div class="sect-t">' + esc(node.title) + '</div><ul class="lns">' +
          (node.items || []).map(function (it) {
            return '<li>' + esc(it.text) + ' ' + badge(it.confidence) +
              (it.extra ? '<span class="src"> ' + esc(it.extra) + '</span>' : '') +
              (it.url ? ' <a href="' + esc(it.url) + '" target="_blank" rel="noopener">来源</a>' : '') +
              '</li>';
          }).join('') + '</ul>';
      }).join('')) +
      ((d.gaps || []).length ? '<div class="note">查不到的部分（不编）：' +
        d.gaps.map(function (g) { return esc(g.reason); }).join('；') + '</div>' : '') +
      '<div class="src">证据链 ' + ((d.provenance || []).length) + ' 条；结论只来自有出处的条目，未证实项已标注。</div>' +
      '</div>' + renderCompare(c);
    $('#pTrace').innerHTML = html;
  }

  function renderTricks(p) {
    var list = p.tricks || [];
    $('#pTrick').innerHTML = '<div class="sect-t">宣称 vs 事实</div>' +
      (list.length ? list.map(function (t) {
        var badge = t.ok ? '<i class="k">标注属实</i>' : (t.edu ? '<i class="k">品类科普</i>' : '<i class="k">存疑</i>');
        return '<div class="trick' + (t.ok ? ' clean' : '') + (t.edu ? ' edu' : '') + '">' +
          '<div class="cl">' + esc(t.claim) + badge + '</div>' +
          '<div class="tr">' + esc(t.truth) + '</div>' +
          '<div class="gd">判定依据：' + esc(String(t.basis || '').replace(/<[^>]*>/g, '')) + '</div></div>';
      }).join('') : '<div class="you-empty">这件商品没有可核对的正面宣称（如「0 蔗糖」「低脂」）。识别到宣称后再拆。</div>') +
      '<div class="note">判定只看营养成分表的数字，不看包装正面的大字。国标阈值：无糖 ≤0.5g/100mL、无能量 ≤17kJ/100mL（GB 28050）。</div>';
  }

  function renderPair(p) {
    var pairs = p.pairs || [], health = p.health || [];
    if (!pairs.length && !health.length) {
      $('#pPair').innerHTML = '<div class="you-empty">演示库没有这款的搭配与人群数据，不编。接后端后按配料与公开标准生成。</div>';
      return;
    }
    $('#pPair').innerHTML = '<div class="sect-t">和什么一起吃要留意</div>' +
      (pairs.length ? pairs.map(function (x) {
        return '<div class="you-item"><div class="h">' + esc(x.with) + '</div><div class="d">' + esc(x.why) + '</div></div>';
      }).join('') : '<div class="you-empty">这款没有单独的搭配条目。</div>') +
      (health.length ? '<div class="sect-t pair-sub">这些人群要留意</div>' +
        health.map(function (h) {
          return '<div class="you-item' + (h.level === 'risk' ? ' risk' : '') + '"><div class="h">' +
            '<span class="tag pill ' + (h.level === 'risk' ? 'bad' : 'good') + '">' +
            (h.level === 'risk' ? '注意' : '可以') + '</span>' + esc(h.tag) + '</div>' +
            '<div class="d">' + esc(h.text) + '</div></div>';
        }).join('') : '') +
      '<div class="note">通用饮食常识的演示整理，不构成医疗建议；疾病、孕期与用药请遵医嘱。过敏原请在「我的情况」里勾选，「为你」会单独提醒。</div>';
  }

  function renderBuzz(p) {
    // 口碑：把其他平台的真实评价搬进项目（后端联网抓取 + AI 归纳）
    if (p.reviews) { renderReviews(p.reviews); return; }
    if (p._reviewsLoading) return;
    var name = p.name || '';
    if (!name || name === '未知产品' || name === '未命名商品') {
      $('#pBuzz').innerHTML = '<div class="you-empty">这款还没拿到商品名，没法联网搜口碑。<br>换一个能识别出商品名的商品试试。</div>';
      return;
    }
    p._reviewsLoading = true;
    $('#pBuzz').innerHTML = '<div class="sect-t">联网口碑</div>' +
      '<div class="you-empty">正在联网搜真实评价并归纳整理…<br>几秒钟就好。</div>';
    var ingredients = '';
    if (p.ocrText) {
      var m = p.ocrText.match(/配料表?[:：]\s*([^\n]+)/);
      ingredients = m ? m[1] : p.ocrText.slice(0, 120);
    } else if (p.ingredients) {
      ingredients = p.ingredients.map(function (i) { return i.name; }).join('、');
    }
    fetchTimeout('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        brand: p.brand || '',
        category: p.category || '',
        ingredients: ingredients
      })
    }, 120000).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && !d.error) {
          p.reviews = d;
          renderReviews(d);
        } else {
          $('#pBuzz').innerHTML = '<div class="you-empty">这次没抓到足够的公开评价。' +
            (d && d.error ? '（' + esc(d.error) + '）' : '') + '<br>可以过一会儿再试试。</div>';
        }
      })
      .catch(function () {
        $('#pBuzz').innerHTML = '<div class="you-empty">连不上后端，口碑暂时取不到。</div>';
      })
      .finally(function () { p._reviewsLoading = false; });
  }

  function bar(label, v, max) {
    var pct = Math.max(0, Math.min(100, Math.round((v / (max || 5)) * 100)));
    return '<div class="taste-row"><span class="taste-l">' + esc(label) + '</span>' +
      '<span class="taste-bar"><i style="width:' + pct + '%"></i></span>' +
      '<span class="taste-v">' + esc(String(v)) + '</span></div>';
  }

  function renderReviews(r) {
    var t = r.taste || {};
    var html = '<div class="sect-t">大多数人怎么说</div>' +
      '<div class="you-item tip"><div class="d" style="font-size:14px;line-height:1.7">' + esc(r.mainstream || '网上公开评价较少，可参考下方原文。') + '</div></div>';

    // 口味画像（创新：量化口感维度）
    if (t.label || t.crisp || t.sweet || t.salt) {
      html += '<div class="sect-t">口味画像</div>' +
        '<div class="you-item"><div class="d" style="margin-bottom:8px">' + esc(t.label || '') + '</div>' +
        bar('甜', t.sweet || 0) + bar('咸', t.salt || 0) + bar('辣', t.spicy || 0) +
        bar('脆', t.crisp || 0) + bar('浓郁', t.rich || 0) + '</div>';
    }

    // 真实评价原文（带来源，点开在项目内查看原文页面）
    if (r.quotes && r.quotes.length) {
      html += '<div class="sect-t">真实评价原文 <span style="font-weight:400;font-size:11px;color:var(--color-muted)">（' + r.quotes.length + ' 条，来自公开搜索，点开看原文）</span></div>' +
        '<div class="quote-list">' +
        r.quotes.slice(0, 6).map(function (q) {
          var srcName = q.source === 'bing' ? '必应' : q.source === '360' ? '360' : q.source === 'sogou' ? '搜狗' : '百度';
          return '<button type="button" class="quote-item" data-q="' + esc(q.text) + '" data-src="' + esc(srcName) + '" data-url="' + esc(q.url || '') + '">' +
            '<div class="d">“' + esc(q.text) + '”</div>' +
            '<div class="src">来源：' + esc(srcName) + ' · 点击查看原文</div></button>';
        }).join('') + '</div>';
    }

    if (r.highlights && r.highlights.length) {
      html += '<div class="sect-t">好评精选</div>' +
        '<div class="you-item tip">' + r.highlights.map(function (h) {
          return '<div class="d" style="margin-bottom:6px">· ' + esc(h) + '</div>';
        }).join('') + '</div>';
    }

    if (r.complaints && r.complaints.length) {
      html += '<div class="sect-t">吐槽预警</div>' +
        '<div class="you-item risk">' + r.complaints.map(function (c) {
          return '<div class="d" style="margin-bottom:6px">· ' + esc(c) + '</div>';
        }).join('') + '</div>';
    }

    // 创新：同好还吃什么（点开 → 查本地商品库 → 直接看那款的解读）
    if (r.similar && r.similar.length) {
      html += '<div class="sect-t">喜欢它的人还吃什么 <span style="font-weight:400;font-size:11px;color:var(--color-muted)">（点一下查商品库）</span></div>' +
        '<div class="pills-row">' + r.similar.map(function (s) {
          return '<button type="button" class="pill none similar-chip" data-name="' + esc(s) + '">' + esc(s) + '</button>';
        }).join('') + '</div>';
    }

    // 创新：吃法灵感 + 踩坑提醒
    var inv = r.innovation || {};
    if (inv.hack || inv.pairing || inv.warning) {
      html += '<div class="sect-t">怎么吃更香 · 别踩的坑</div>';
      if (inv.hack) { html += '<div class="you-item"><div class="h">💡 吃法脑洞</div><div class="d">' + esc(inv.hack) + '</div></div>'; }
      if (inv.pairing) { html += '<div class="you-item"><div class="h">🥤 搭配灵感</div><div class="d">' + esc(inv.pairing) + '</div></div>'; }
      if (inv.warning) { html += '<div class="you-item risk"><div class="h">⚠️ 容易踩的坑</div><div class="d">' + esc(inv.warning) + '</div></div>'; }
    }

    // 适合谁 / 不适合谁
    var aud = r.audience || {};
    if ((aud.good && aud.good.length) || (aud.bad && aud.bad.length)) {
      html += '<div class="sect-t">适合谁</div>';
      if (aud.good && aud.good.length) {
        html += '<div class="you-item tip"><div class="d">✅ ' + aud.good.map(esc).join('；') + '</div></div>';
      }
      if (aud.bad && aud.bad.length) {
        html += '<div class="you-item risk"><div class="d">❌ ' + aud.bad.map(esc).join('；') + '</div></div>';
      }
    }

    html += '<div class="note">口碑来自百度、必应、360、搜狗等公开搜索结果的真实评价摘录，由 AI 归纳整理；评价主观，仅供参考，不代表平台立场。</div>';
    $('#pBuzz').innerHTML = html;
  }

  // 在项目内部查看评价原文页面：后端抓取 → 提取正文 → 弹层展示
  function loadReviewPage(url) {
    var loading = $('#pageLoading'), title = $('#pageTitle'), body = $('#pageBody'), note = $('#pageNote');
    if (title) title.hidden = true;
    if (body) { body.hidden = true; body.textContent = ''; }
    if (note) note.hidden = true;
    if (!url) {
      if (loading) loading.hidden = true;
      if (note) { note.textContent = '这条评价来自搜索摘要（360/搜狗等），没有可直接抓取的原文页面链接。'; note.hidden = false; }
      return;
    }
    if (loading) { loading.hidden = false; loading.textContent = '正在抓取原文页面…'; }
    fetchTimeout('/api/review-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    }, 25000).then(function (r) { return r.json(); })
      .then(function (d) {
        if (loading) loading.hidden = true;
        if (d && d.text) {
          if (title) { title.textContent = d.title || '原文页面'; title.hidden = false; }
          if (body) { body.textContent = d.text; body.hidden = false; }
        } else {
          if (note) {
            note.textContent = '原文页面抓取失败（' + ((d && d.error) || '未知原因') + '），该网站可能需要登录或禁止抓取。';
            note.hidden = false;
          }
        }
      })
      .catch(function () {
        if (loading) loading.hidden = true;
        if (note) { note.textContent = '原文抓取失败（网络问题），稍后再试。'; note.hidden = false; }
      });
  }

  // 同好推荐点开：查本地商品库，命中就直接 AI 解读那款（项目内跳转）
  function openSimilarProduct(name) {
    if (!name) return;
    showBusy('正在商品库里找「' + name + '」…');
    busyFetch('/api/search-product?name=' + encodeURIComponent(name), {}, 15000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        hideBusy();
        if (d && d.found && d.products && d.products.length) {
          var prod = d.products[0];
          if (prod.ingredients && prod.ingredients.length >= 4) {
            toast('找到「' + (prod.name || name) + '」，正在解读…');
            return analyzeByText(prod.ingredients, {
              name: prod.name || name, brand: prod.brand || '', category: prod.categories || ''
            }, 'barcode');
          }
          toast('找到「' + (prod.name || name) + '」，但这瓶没有配料表数据，拍一下更准');
        } else {
          toast('商品库里暂时没收录「' + name + '」，可以拍它的配料表');
        }
      })
      .catch(function () {
        hideBusy();
        if (busyCanceled) return;   // 用户自己点了「返回」
        toast('连不上后端，稍后再试');
      });
  }

  function renderYou(p) {
    var prefs = read(LS_PREF, []), algs = read(LS_ALLERGY, []);
    var hits = (p.health || []).filter(function (h) {
      var parts = h.tag.split('/').map(function (x) { return x.trim(); });
      return prefs.some(function (t) {
        var tp = t.split('/').map(function (x) { return x.trim(); });
        return parts.some(function (a) { return tp.some(function (b) { return a.indexOf(b) !== -1 || b.indexOf(a) !== -1; }); });
      });
    });

    // 过敏原命中：AI 解读结果用后端已过滤的 allergens；示例商品用前端匹配
    var algHits = (typeof p.allergens !== 'undefined')
      ? (p.allergens || [])
      : ((window.DG_ALLERGENS && window.DG_ALLERGENS.match)
        ? window.DG_ALLERGENS.match(p.ingredients, algs)
        : []);

    var html = '';
    if (!prefs.length && !algs.length) {
      html = '<div class="you-empty">还没告诉我们要照顾谁。<br>点右上角「我的情况」勾一下（控糖、乳糖不耐、给孩子买…），这里就会只挑跟你有关的说。</div>';
    } else {
      if (algHits.length) {
        html += '<div class="sect-t">过敏原命中</div>' +
          algHits.map(function (h) {
            var isCore = h.group === 'core';
            return '<div class="you-item ' + (isCore ? 'risk' : 'tip') + '">' +
              '<div class="h"><span class="tag pill ' + (isCore ? 'bad' : '') + '">' +
              (isCore ? '过敏' : '注意') + '</span>' + esc(h.full) +
              '</div><div class="d">配料里写作：' + esc(h.matched.join('、')) + '。' +
              (isCore ? '配料里有这个，建议直接放下。' : '属其他致敏食物，按自身情况判断，不确定就换一款。') +
              '</div></div>';
          }).join('');
      }
      if (hits.length) {
        html += '<div class="sect-t">按你的情况</div>' +
          hits.map(function (h) {
            return '<div class="you-item ' + (h.level === 'risk' ? 'risk' : 'tip') + '">' +
              '<div class="h"><span class="tag pill ' + (h.level === 'risk' ? 'bad' : 'good') + '">' +
              (h.level === 'risk' ? '注意' : '可以') + '</span>' + esc(h.tag) + '</div>' +
              '<div class="d">' + esc(h.text) + '</div></div>';
          }).join('');
      }
      if (p.pairs && p.pairs.length) {
        html += '<div class="sect-t">搭配注意</div>' +
          p.pairs.map(function (x) {
            return '<div class="you-item"><div class="h">' + esc(x.with) + '</div><div class="d">' + esc(x.why) + '</div></div>';
          }).join('');
      }
      if (!hits.length && !algHits.length) {
        html += p.id === 'unknown'
          ? '<div class="you-empty">这款没匹配到商品档案，按你勾的情况逐项核对做不了。不做没有依据的「没问题」结论。</div>'
          : '<div class="you-empty">按你勾的情况没有特别要提醒的，这款对你没有明显冲突。</div>';
      }
    }
    $('#pYou').innerHTML = html;
    var yn = hits.length + algHits.length;
    $('#youDot').hidden = !yn;
    $('#youDot').textContent = yn ? '(' + yn + ')' : '';
  }

  function switchTab(name, silent) {
    state.tab = name;
    $$('#tabs .tab').forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    $$('.panel').forEach(function (p) { p.classList.toggle('on', p.dataset.panel === name); });
    if (!silent) syncHash();
  }

  /* ---------------- 偏好抽屉 ---------------- */
  // 过敏原搜索：用户输入"花生/芒果/虾"等，匹配到对应致敏类别（支持别名/配料词）
  function renderAllergySearch(q) {
    var box = $('#allergySearchResult');
    if (!box) return;
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    var A = window.DG_ALLERGENS;
    if (!A) { box.hidden = true; return; }
    // 相关度排序：类别名完全匹配 > 类别名包含 > 全称包含 > 别名 > 配料词包含
    var scored = [];
    A.categories.forEach(function (c) {
      var s = 0;
      if (c.name === q) s = 100;
      else if ((c.name || '').indexOf(q) >= 0) s = 80;
      else if ((c.full || '').indexOf(q) >= 0) s = 60;
      else if ((c.aliases || []).some(function (a) { return a.indexOf(q) >= 0; })) s = 50;
      else if ((c.items || []).some(function (k) { return k.indexOf(q) >= 0; })) s = 30;
      else if ((c.items || []).some(function (k) { return q.indexOf(k) >= 0; })) s = 20;
      if (s > 0) scored.push({ c: c, s: s });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    var hits = scored.slice(0, 8).map(function (x) { return x.c; });
    if (!hits.length) {
      box.innerHTML = '<span class="search-empty">没找到「' + esc(q) + '」相关的致敏类别，换个写法试试（如：虾、牛奶、花生、芒果）。</span>';
      box.hidden = false;
      return;
    }
    var algs = read(LS_ALLERGY, []);
    box.innerHTML = hits.map(function (c) {
      var on = algs.indexOf(c.id) !== -1;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-a="' + esc(c.id) + '" title="' + esc(c.full) + '">' +
        (on ? '✓ ' : '+ ') + esc(c.name) + '</button>';
    }).join('');
    box.hidden = false;
  }

  function renderPrefs() {
    var prefs = read(LS_PREF, []), algs = read(LS_ALLERGY, []);
    $('#prefChips').innerHTML = PREF_TAGS.map(function (t) {
      var on = prefs.indexOf(t) !== -1;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-t="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
    var A = window.DG_ALLERGENS;
    if (A) {
      var core = A.categories.filter(function (c) { return c.group === 'core'; });
      var ext = A.categories.filter(function (c) { return c.group === 'ext'; });
      var chipHtml = function (c) {
        var on = algs.indexOf(c.id) !== -1;
        return '<button type="button" class="chip' + (on ? ' on' : '') + '" aria-pressed="' + on +
          '" data-a="' + esc(c.id) + '" title="' + esc(c.full + '：' + c.include) + '">' + esc(c.name) + '</button>';
      };
      $('#allergyChips').innerHTML = core.map(chipHtml).join('');
      $('#allergyChips2').innerHTML = ext.map(chipHtml).join('');
      var moreBtn = $('#allergyMore');
      if (moreBtn) {
        var box2 = $('#allergyChips2');
        moreBtn.textContent = ext.length ? ((box2.hidden ? '显示' : '收起') + '其他致敏食物（' + ext.length + ' 类）') : '';
        moreBtn.setAttribute('aria-expanded', String(!box2.hidden));
      }
    }
    var n = prefs.length + algs.length;
    $('#prefDot').hidden = !n;
    $('#prefDot').textContent = n ? '(' + n + ')' : '';

    $$('#prefChips .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        var v = c.dataset.t, a = read(LS_PREF, []), i = a.indexOf(v);
        if (i === -1) a.push(v); else a.splice(i, 1);
        store(LS_PREF, a); renderPrefs(); if (state.product) renderYou(state.product);
      });
    });
    $$('#allergyChips .chip, #allergyChips2 .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        var v = c.dataset.a, a = read(LS_ALLERGY, []), i = a.indexOf(v);
        if (i === -1) a.push(v); else a.splice(i, 1);
        store(LS_ALLERGY, a); renderPrefs(); if (state.product) renderYou(state.product);
      });
    });

    // 过敏原搜索：输入食物名 → 匹配致敏类别 → 点一下勾选
    var algSearch = $('#allergySearch');
    if (algSearch && !algSearch.dataset.bound) {
      algSearch.dataset.bound = '1';
      algSearch.addEventListener('input', function () { renderAllergySearch(this.value.trim()); });
      var algResult = $('#allergySearchResult');
      if (algResult) {
        algResult.addEventListener('click', function (e) {
          var c = e.target.closest('.chip');
          if (!c) return;
          var v = c.dataset.a, a = read(LS_ALLERGY, []), i = a.indexOf(v);
          if (i === -1) a.push(v); else a.splice(i, 1);
          store(LS_ALLERGY, a);
          renderAllergySearch(algSearch.value.trim());
          renderPrefs();
          if (state.product) renderYou(state.product);
        });
      }
    }
    var moreBtn2 = $('#allergyMore');
    if (moreBtn2 && !moreBtn2.dataset.bound) {
      moreBtn2.dataset.bound = '1';
      moreBtn2.addEventListener('click', function () {
        var box = $('#allergyChips2');
        box.hidden = !box.hidden;
        renderPrefs();
      });
    }
  }

  /* ---------------- 分享卡片 ---------------- */
  // 卡片用 CON 常量，与 tokens.css 的 Console 调色板一致；Canvas 读不了 CSS 变量，直接写同一组 oklch
  var CON = {
    paper: '#F3EDE1', panel: '#FCF8EF', deep: '#E9E1CE',
    ink: '#221D12', ink2: '#4C4636', muted: '#8A7F66',
    rule: '#DCD2BC',
    amber: '#F2B32C', cool: '#3E6B8F',
    ok: '#3E7C4F', bad: '#C6462B', badSoft: '#F7E1D6'
  };
  var Fdisp = '"Host Grotesk","PingFang SC","Microsoft YaHei",sans-serif';
  var Fbody = Fdisp;
  var Fmono = 'ui-monospace,"Cascadia Mono",Consolas,monospace';

  function drawCard(p) {
    var c = $('#shareCanvas');
    var W = 1200, H = 900, M = 56, RX = 600, RW = W - M - RX;
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    var tone = p.verdict.level === 'bad' ? CON.bad : p.verdict.level === 'good' ? CON.ok : CON.amber;

    x.fillStyle = CON.paper; x.fillRect(0, 0, W, H);

    function rule(y, x0, x1, col) {
      x.strokeStyle = col || CON.rule; x.lineWidth = 1;
      x.beginPath(); x.moveTo(x0, y); x.lineTo(x1, y); x.stroke();
    }

    x.fillStyle = CON.muted; x.font = '500 24px ' + Fbody;
    x.fillText('DeepEggy 看得懂的配料表', M, 84);
    x.fillStyle = CON.cool; x.font = '400 22px ' + Fmono; x.textAlign = 'right';
    x.fillText(p.barcode, W - M, 84);
    x.textAlign = 'left';
    rule(108, M, W - M);

    x.fillStyle = CON.muted; x.font = '400 22px ' + Fbody;
    x.fillText(p.brand + '，' + p.spec, M, 152);
    x.fillStyle = CON.ink; x.font = '500 40px ' + Fdisp;
    wrap(x, p.name, M, 200, 470, 52, 2);

    x.fillStyle = tone; x.font = '500 60px ' + Fdisp;
    x.fillText(p.verdict.label, M, 336);
    x.fillStyle = CON.ink2; x.font = '400 24px ' + Fbody;
    wrap(x, p.verdict.why, M, 388, 470, 36, 4);

    p.keys.forEach(function (k, i) {
      var top = 152 + i * 112;
      x.fillStyle = k.hi ? CON.amber : CON.muted; x.font = '400 22px ' + Fbody;
      x.fillText(k.l, RX, top);
      x.fillStyle = CON.ink;
      x.font = '400 48px ' + Fmono;
      x.fillText(k.v, RX, top + 58);
      x.fillStyle = CON.muted; x.font = '400 22px ' + Fbody; x.textAlign = 'right';
      x.fillText(k.u, RX + RW, top + 58);
      x.textAlign = 'left';
      rule(top + 84, RX, RX + RW);
    });

    rule(580, M, W - M);
    x.fillStyle = CON.muted; x.font = '500 22px ' + Fbody;
    x.fillText('最需要留意的几项', M, 620);
    var algs = p.allergens || [];
    if (algs.length) {
      var labelW = x.measureText('最需要留意的几项').width;
      x.fillStyle = CON.bad; x.font = '500 22px ' + Fbody;
      x.fillText('  ·  含致敏物质：' + algs.map(function (a) { return a.full; }).join('、'), M + labelW, 620);
    }
    var warns = p.ingredients.filter(function (i) { return i.flag !== 'green'; }).slice(0, 4);
    warns.forEach(function (w, i) {
      var cx = i % 2 === 0 ? M : RX;
      var y = 664 + Math.floor(i / 2) * 40;
      x.fillStyle = w.flag === 'red' ? CON.bad : CON.ink;
      x.font = '500 26px ' + Fbody;
      x.fillText(w.name, cx, y);
      var nw = x.measureText(w.name).width;
      x.fillStyle = CON.muted; x.font = '400 22px ' + Fbody;
      x.fillText(w.role || '', cx + nw + 16, y);
    });

    var tr = p.tricks.filter(function (t) { return !t.ok && !t.edu; })[0];
    if (tr) {
      x.fillStyle = CON.badSoft; x.fillRect(M, 736, W - M * 2, 112);
      x.fillStyle = CON.bad; x.fillRect(M, 736, 6, 112);
      x.fillStyle = CON.ink; x.font = '500 24px ' + Fbody;
      x.fillText(tr.claim, M + 24, 770);
      x.font = '400 22px ' + Fbody;
      var lines = splitLines(x, tr.truth.replace(/<[^>]+>/g, ''), W - M * 2 - 48, 2);
      x.fillStyle = CON.ink2;
      lines.forEach(function (ln, i) { x.fillText(ln, M + 24, 802 + i * 30); });
    }

    x.fillStyle = CON.muted; x.font = '400 20px ' + Fbody;
    x.fillText('首届 AgriHackathon 参赛作品，演示数据，解读依据公开国标，不构成医疗建议', M, 880);
  }

  function splitLines(ctx, text, maxW, maxLines) {
    var chars = String(text).split(''), out = [], line = '';
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxW && line) {
        out.push(line); line = chars[i];
        if (maxLines && out.length === maxLines) { out[out.length - 1] += '…'; return out; }
      } else { line = test; }
    }
    if (line) out.push(line);
    return out;
  }

  function wrap(ctx, text, x, y, maxW, lh, maxLines) {
    var chars = String(text).split(''), line = '', yy = y, n = 0;
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, yy); line = chars[i]; yy += lh; n++;
        if (maxLines && n >= maxLines) { ctx.fillText(line + '…', x, yy); return; }
      } else { line = test; }
    }
    ctx.fillText(line, x, yy);
    return yy;
  }

  function saveCard() {
    var p = state.product; if (!p) return;
    var cv = $('#shareCanvas');
    cv.toBlob(function (blob) {
      if (!blob) { toast('这台设备不让保存图片'); return; }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '配料表解读-' + p.name.slice(0, 10) + '.png';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast('已保存卡片');
    }, 'image/png');
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    var backBtn = $('#btnBack');
    if (backBtn) backBtn.addEventListener('click', goBack);
    $('#btnBarcode').addEventListener('click', function () {
      state.mode = 'barcode'; showView('viewScan');
      $('#scanMode').style.display = '';
      startCamera();
    });
    // capture=environment 会在手机上直接调后置相机；相册上传保留为单独入口。
    $('#btnLabel').addEventListener('click', function () {
      state.mode = 'label';
      var inp = $('#cameraInput');
      if (inp) inp.click();
    });
    $('#btnCamOff').addEventListener('click', function () { stopCamera(); showView('viewHome'); });
    $('#btnShoot').addEventListener('click', function () {
      var frame = grabFrame();
      $('#btnShoot').disabled = true;
      detectOnce(frame).then(function (code) {
        $('#btnShoot').disabled = false;
        if (code) { onCodeFound(code); }
        else {
          stopCamera();
          if (!frame) { toast('没有拍到画面，请重试'); return; }
          stopCamera();
          frame.toBlob(function (blob) {
            if (blob) startLabelFlow(blob);
            else { toast('图片读取失败，请重试'); showView('viewHome'); }
          }, 'image/jpeg', 0.9);
        }
      }).catch(function () {
        $('#btnShoot').disabled = false;
        if (!frame) { toast('没有拍到画面，请重试'); return; }
        stopCamera();
        frame.toBlob(function (blob) {
          if (blob) startLabelFlow(blob);
          else { toast('图片读取失败，请重试'); showView('viewHome'); }
        }, 'image/jpeg', 0.9);
      });
    });
    $('#btnCode').addEventListener('click', function () {
      var v = $('#codeInput').value.trim();
      if (!v) { toast('先输一个条码，或点首页示例'); return; }
      onCodeFound(v);
    });
    $('#codeInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btnCode').click(); });
    $('#imgInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) startLabelFlow(f);
    });
    $('#cameraInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) startLabelFlow(f);
    });

    $('#tabs').addEventListener('click', function (e) {
      var t = e.target.closest('.tab'); if (t) switchTab(t.dataset.tab);
    });
    $('#tabs').addEventListener('keydown', function (e) {
      var keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (keys.indexOf(e.key) < 0) return;
      var tabs = $$('#tabs .tab');
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = tabs.length - 1;
      else i = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      switchTab(tabs[i].dataset.tab);
      tabs[i].focus();
    });

    $('#prefBtn').addEventListener('click', function () { renderPrefs(); openSheet($('#prefSheet')); });
    var btnHotness = $('#btnHotness');
    if (btnHotness) btnHotness.addEventListener('click', openHotness);
    // 微信扫码页查询：传扫码页截图 OCR 出商品名（或手输）→ 联网找配料表 → 解读
    var btnWechat = $('#btnWechat');
    if (btnWechat) btnWechat.addEventListener('click', function () { openSheet($('#wechatSheet')); });
    var btnWxQuery = $('#btnWxQuery');
    if (btnWxQuery) btnWxQuery.addEventListener('click', function () {
      var nm = ($('#wxName') && $('#wxName').value || '').trim();
      var br = ($('#wxBrand') && $('#wxBrand').value || '').trim();
      if (!nm) { toast('先输入商品名称（微信扫码页上那个），或者传一张扫码页截图'); return; }
      closeSheet($('#wechatSheet'));
      analyzeBarcodeWeb({ name: nm, brand: br }, '', 'name');
    });
    // 传微信扫码页截图 → OCR 自动提取商品名 / 品牌
    var wxShot = $('#wxShotInput');
    if (wxShot && !wxShot.dataset.bound) {
      wxShot.dataset.bound = '1';
      wxShot.addEventListener('change', function () {
        var f = this.files && this.files[0];
        if (!f) return;
        showBusy('正在认扫码页里的商品名…');
        fileToBase64(f, function (b64) {
          if (!b64) { hideBusy(); toast('图片读取失败，请重试'); return; }
          busyFetch('/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: b64 })
          }, 60000).then(function (r) { return r.json(); })
            .then(function (d) {
              if (d && d.text) {
                var parsed = parseWechatOcr(d.text);
                var nameEl = $('#wxName'), brandEl = $('#wxBrand');
                if (nameEl && parsed.name) nameEl.value = parsed.name;
                if (brandEl && parsed.brand) brandEl.value = parsed.brand;
                if (parsed.name) {
                  toast('识别到商品：' + parsed.name + (parsed.brand ? '，正在查配料表…' : ''));
                  closeSheet($('#wechatSheet'));
                  analyzeBarcodeWeb({ name: parsed.name, brand: parsed.brand }, '', 'name');
                } else {
                  toast('没识别出商品名，手动输入一下');
                }
              } else {
                toast('识别失败：' + ((d && d.error) || '换张更清晰的截图'));
              }
            })
            .catch(function () {
              if (busyCanceled) return;   // 用户自己点了「返回」
              toast('识别失败（网络），请手动输入');
            })
            .finally(function () { hideBusy(); });
        });
      });
    }

    // 解析截图 OCR 文本 → {name, brand}
    function parseWechatOcr(text) {
      var lines = String(text || '').split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      var name = '', brand = '';
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var mb = ln.replace(/^\s*/, '').match(/^品牌[：:\s]*(.+)$/);
        if (mb) brand = mb[1].replace(/[，,。;；\s]+$/g, '').trim();
      }
      // 商品名：第一行不是"规格/品牌/企业/编码中心"之类的短行
      for (var j = 0; j < lines.length; j++) {
        var l = lines[j];
        if (/^(规格|品牌|企业|生产商|产地|中国物品编码中心|条码)/.test(l)) continue;
        if (l.length >= 3 && l.length <= 40) { name = l; break; }
      }
      return { name: name, brand: brand };
    }
    $('#btnNext').addEventListener('click', function () { stopCamera(); showView('viewHome'); });
    $('#btnShare').addEventListener('click', function () {
      if (!state.product) return;
      drawCard(state.product); openSheet($('#shareSheet'));
    });
    $('#btnSaveCard').addEventListener('click', saveCard);

    // 口碑页交互：评价点开详情、同好推荐联动商品库
    var buzzPanel = $('#pBuzz');
    if (buzzPanel && !buzzPanel.dataset.bound) {
      buzzPanel.dataset.bound = '1';
      buzzPanel.addEventListener('click', function (e) {
        var qi = e.target.closest('.quote-item');
        if (qi) {
          var txt = qi.getAttribute('data-q') || '';
          var src = qi.getAttribute('data-src') || '';
          var qurl = qi.getAttribute('data-url') || '';
          var qt = $('#quoteText'), qs = $('#quoteSrc');
          if (qt) qt.textContent = '“' + txt + '”';
          if (qs) qs.textContent = '来源：' + src + ' · ' + (qurl ? '下方为该项目内抓取的原文页面内容' : '搜索摘要');
          openSheet($('#quoteSheet'));
          loadReviewPage(qurl);
          return;
        }
        var sc = e.target.closest('.similar-chip');
        if (sc) openSimilarProduct(sc.getAttribute('data-name'));
      });
    }

    // 处理中遮罩：等太久时给「继续等 / 返回」两个出口
    var btnBusyBack = $('#btnBusyBack'), btnBusyWait = $('#btnBusyWait');
    if (btnBusyBack) btnBusyBack.addEventListener('click', escapeBusy);
    if (btnBusyWait) btnBusyWait.addEventListener('click', function () {
      armBusyEscape(BUSY_ESCAPE_AGAIN_MS);   // 收起来，再等一会儿还没结果就再问一次
    });

    $$('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        var sh = b.closest('.sheet');
        if (sh) closeSheet(sh);
      });
    });
    $$('.sheet').forEach(function (sh) {
      sh.addEventListener('click', function (e) { if (e.target === sh) closeSheet(sh); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        // 正在查的时候按 Esc 等同「返回」：先让这次查询停下，不把人困在转圈里
        var busyEl = $('#busy');
        if (busyEl && !busyEl.hidden) { e.preventDefault(); escapeBusy(); return; }
        var openSh = $$('.sheet').filter(function (s) { return !s.hidden; })[0];
        if (openSh) { e.preventDefault(); closeSheet(openSh); return; }
        // 没有弹层时，Esc 等同返回键，回上一屏
        if (state.view !== 'viewHome') { e.preventDefault(); goBack(); return; }
      }
      var sh = $$('.sheet').filter(function (s) { return !s.hidden; })[0];
      if (!sh) return;
      if (e.key !== 'Tab') return;
      var items = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', sh)
        .filter(function (n) { return !n.disabled && n.getClientRects().length; });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopCamera();
    });
  }

  bind();
  renderHome();
  renderPrefs();
  loadProductIndex();
  if (!routeFromHash()) showView('viewHome');
  booting = false;   // 首屏渲染完，之后的每一次切屏才写历史
})();
