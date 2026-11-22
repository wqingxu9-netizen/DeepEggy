/* 看得懂的配料表，DeepEggy 前端逻辑
   零构建原生 JS。演示阶段数据来自 mock.js，接口对齐后替换 loadProduct()。 */

(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var LS_PREF = 'dg_prefs', LS_ALLERGY = 'dg_allergies', LS_HIST = 'dg_history';

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
  function showView(id) {
    $$('.view').forEach(function (v) { v.hidden = v.id !== id; });
    $('#actionbar').hidden = (id !== 'viewResult');
    state.view = id;
    if (id === 'viewHome') loadProductIndex();
    syncHash();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 当前屏与商品写进地址栏：可以转发给队友，浏览器返回也回得到
  function syncHash() {
    var names = { viewHome: 'home', viewScan: 'scan', viewResult: 'result' };
    var h = '#' + (names[state.view] || 'home');
    if (state.view === 'viewResult' && state.product && state.product.id !== 'unknown') {
      h += '?p=' + encodeURIComponent(state.product.id) + '&t=' + state.tab;
    }
    if (h !== location.hash) history.replaceState(null, '', h);
  }

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
  var IDX_TAGS = ['全部', '水', '饮料', '乳制品', '茶咖', '薯片', '饼干', '糕点面包', '糖果巧克力', '方便食品', '坚果零食', '其他'];

  function loadProductIndex() {
    if (idx.loaded || idx.loading) return;
    idx.loading = true;
    var box = $('#idxList');
    if (box) box.innerHTML = '<div class="idx-tip">正在加载商品索引…</div>';
    fetchTimeout('/api/products', {}, 20000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        idx.all = (d && d.products) || [];
        idx.loaded = true;
        $('#idxTotal').textContent = idx.all.length ? '共 ' + idx.all.length + ' 款' : '';
        renderIdxChips();
        renderIdxList();
      })
      .catch(function () {
        if (box) box.innerHTML = '<div class="idx-tip">商品索引加载失败，可下拉刷新重试</div>';
      })
      .finally(function () { idx.loading = false; });
  }

  function idxFiltered() {
    return idx.tag === '全部' ? idx.all : idx.all.filter(function (p) { return p.tag === idx.tag; });
  }

  function renderIdxChips() {
    var counts = {};
    idx.all.forEach(function (p) { counts[p.tag] = (counts[p.tag] || 0) + 1; });
    $('#idxChips').innerHTML = IDX_TAGS.filter(function (t) {
      return t === '全部' || counts[t];
    }).map(function (t) {
      var n = t === '全部' ? idx.all.length : counts[t];
      return '<button class="chip' + (t === idx.tag ? ' on' : '') + '" data-tag="' + esc(t) + '">' +
        esc(t) + '<span class="chip-n">' + n + '</span></button>';
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
      return '<button class="demo-item" data-code="' + esc(p.code) + '">' +
        '<span class="n">' + esc(p.name) + '</span>' +
        '<span class="b">' + esc(p.brand || p.tag) + '</span>' +
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

  function openIndexed(code) {
    toast('正在读取商品 ' + code + '…');
    fetchTimeout('/api/scan-barcode?code=' + encodeURIComponent(code), {}, 15000)
      .then(function (r) { return r.json(); })
      .then(function (d) { handleScanResult(d, code); })
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

  function renderHistory() {
    var h = read(LS_HIST, []);
    $('#historyBox').hidden = !h.length;
    $('#historyList').innerHTML = h.map(function (it) {
      return '<button class="demo-item" data-code="' + esc(it.code) + '">' +
        '<span class="n">' + esc(it.name) + '</span>' +
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
    var h = read(LS_HIST, []).filter(function (x) { return x.code !== p.barcode; });
    var d = new Date();
    h.unshift({ code: p.barcode, name: p.name, at: (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) });
    store(LS_HIST, h.slice(0, 6));
  }

  /* ---------------- 相机 / 条码 ---------------- */
  var hasDetector = ('BarcodeDetector' in window);

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#scanTip').textContent = '当前环境不支持相机，请用下面的手动方式或点首页示例';
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (st) {
        state.stream = st;
        var v = $('#cam');
        v.srcObject = st; v.muted = true;
        return v.play().catch(function () {});
      })
      .then(function () {
        $('#scanTip').textContent = hasDetector
          ? '把条形码对准框内，保持 15–25cm'
          : '此浏览器无实时条码识别：可点「拍照识别」，或手输条码';
        loopScan();
      })
      .catch(function () {
        $('#scanTip').textContent = '相机没拿到权限，用下面的手动方式，或点首页示例体验';
      });
  }

  function stopCamera() {
    if (state.stream) { state.stream.getTracks().forEach(function (t) { t.stop(); }); state.stream = null; }
    clearTimeout(state.scanTimer);
    $('#cam').srcObject = null;
  }

  function grabFrame() {
    var v = $('#cam');
    if (!v.videoWidth) return null;
    var c = $('#probe');
    c.width = 480; c.height = Math.round(480 * v.videoHeight / v.videoWidth);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return c;
  }

  function measureLight() {
    var c = grabFrame();
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

  function loopScan() {
    clearTimeout(state.scanTimer);
    var tick = function () {
      measureLight();
      if (hasDetector && state.stream) {
        detectOnce().then(function (code) {
          if (code) { onCodeFound(code); return; }
          state.scanTimer = setTimeout(tick, 420);
        }).catch(function () { state.scanTimer = setTimeout(tick, 900); });
      } else {
        state.scanTimer = setTimeout(tick, 700);
      }
    };
    state.scanTimer = setTimeout(tick, 300);
  }

  function detectOnce(source) {
    if (!hasDetector) return Promise.resolve(null);
    if (!state.detector) {
      try {
        state.detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
      } catch (e) { return Promise.resolve(null); }
    }
    var src = source || $('#cam');
    if (!src || (!src.videoWidth && !src.width)) return Promise.resolve(null);
    return state.detector.detect(src).then(function (res) {
      return res && res.length ? String(res[0].rawValue) : null;
    });
  }

  function onCodeFound(code) {
    stopCamera();
    var p = window.DEMO.lookup(code);
    if (p) {
      toast('识别到条码 ' + code);
      openResult(p, 'barcode');
      return;
    }
    // 本地示例库没有 → 查后端条码库（内置 + OpenFoodFacts + 联网补全）
    fetchTimeout('/api/scan-barcode?code=' + encodeURIComponent(code), {}, 15000)
      .then(function (r) { return r.json(); })
      .then(function (d) { handleScanResult(d, code); })
      .catch(function () {
        toast('连不上后端，条码 ' + code + ' 未收录，改走「拍配料表」');
        startLabelFlow(null);
      });
  }

  // 后端条码查询结果 → 走对应解读路径（扫码命中 / 首页商品索引点击共用）
  function handleScanResult(d, code) {
    if (d && d.found && d.product) {
      var prod = d.product;
      // 内置示例商品（带 id）：从本地补全完整结构
      if (d.source === 'builtin' && prod.id) {
        var local = window.DEMO.list.filter(function (x) { return x.id === prod.id; })[0];
        if (local) { toast('条码 ' + code + ' 已匹配'); openResult(local, 'barcode'); return; }
      }
      // OpenFoodFacts 商品：有配料表直接 AI 解读（带上它的品类，让 AI 按品类给指标）
      if (prod.ingredients && prod.ingredients.length >= 4) {
        toast('找到商品：' + (prod.name || code) + '，AI 正在解读配料表…');
        analyzeByText(prod.ingredients, {
          name: prod.name || '',
          brand: prod.brand || '',
          category: prod.categories || ''
        }, 'barcode');
        return;
      }
      // 联网查到商品身份（编码中心备案 / OFF 在线）但没有配料表 → 联网搜配料表再解读
      if (prod.name) {
        toast('联网找到商品：' + prod.name + '，正在查配料表…');
        analyzeBarcodeWeb(prod, code);
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
  function analyzeBarcodeWeb(prod, code) {
    showBusy('已找到 ' + (prod.name || code) + '，AI 正在联网查配料表…');
    return fetchTimeout('/api/analyze-barcode', {
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
        if (d && d.verdict && d.ingredients) { openResult(d, 'barcode'); }
        else { toast('联网没找到可靠配料表：' + ((d && d.error) || '换个方式，请拍配料表')); startLabelFlow(null); }
      })
      .catch(function () { toast('联网解读失败（网络问题），改走拍配料表'); startLabelFlow(null); })
      .finally(function () { hideBusy(); });
  }

  // 用一段配料表文字走 AI 解读（扫码命中 / 拍照自动提取共用）
  function analyzeByText(text, meta, via) {
    meta = meta || {};
    showBusy('AI 正在读懂这份食品配料…');
    return fetchTimeout('/api/analyze', {
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
      .catch(function () { toast('AI 解读失败（网络问题）'); })
      .finally(function () { hideBusy(); });
  }

  // 带超时的 fetch（避免请求卡住一直转圈）
  function fetchTimeout(url, opts, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 30000);
    opts = opts || {};
    opts.signal = ctrl.signal;
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  // 全屏处理中遮罩
  function showBusy(msg) {
    var b = $('#busy');
    if (!b) return;
    var t = $('#busyTxt');
    if (t) t.textContent = msg || '处理中…';
    b.hidden = false;
  }
  function hideBusy() {
    var b = $('#busy');
    if (b) b.hidden = true;
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
      fetchTimeout('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: b64 })
      }, 60000).then(function (r) {
        if (r.status === 501) return { ocr_off: true };
        return r.json();
      }).then(function (d) {
        if (d && d.text) {
          // OCR 原文不展示给用户；后端会先截取配料区，再匹配本地配料库。
          return analyzeByText(d.text, {}, 'label');
        } else if (d && d.ocr_off) {
          toast('识别服务暂不可用，请稍后重试');
        } else {
          toast('识别失败：' + ((d && d.error) || '未知错误'));
        }
      }).catch(function () {
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
    state.product = p;
    renderResult(p);
    if (p.barcode !== '未采集') { pushHistory(p); renderHistory(); }
    showView('viewResult');
    if (via === 'demo') toast('示例演示数据');
    switchTab('ing');
  }

  function renderResult(p) {
    $('#rBrand').textContent = p.brand;
    $('#rName').textContent = p.name;
    $('#rSpec').textContent = p.spec + '，' + p.category;
    $('#rCode').textContent = p.barcode;

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

  function renderIngredients(p) {
    $('#pIng').innerHTML = '<div class="sect-t">按配料顺序，点一行看详情</div>' +
      p.ingredients.map(function (it, i) {
        var dose = it.dose ? '<div class="dose"><div class="dose-t">这瓶里的量 vs 每日参考</div>' +
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
    var first = $('#pIng .ing');
    if (first) {
      first.classList.add('open');
      $('.ing-h', first).setAttribute('aria-expanded', 'true');
    }
  }

  function renderNutrition(p) {
    var nuts = p.nutrition || [], eqs = p.equiv || [];
    $('#pNut').innerHTML = '<div class="sect-t">营养成分表：每 100mL，以及一整瓶</div>' +
      (nuts.length ? nuts.map(function (n) {
        return '<div class="nrow' + (n.hi ? ' hi' : '') + '"><div class="top">' +
          '<span class="nm">' + esc(n.name) + '</span><span class="val">' + esc(n.per100) + '，整瓶 ' + esc(n.whole) + '</span>' +
          '<span class="nrv">' + (n.nrv ? n.nrv + '%' : '未标') + '</span></div>' +
          '<div class="nbar"><i class="' + (n.hi ? 'bad' : 'good') + '" style="transform:scaleX(' + (Math.min(100, n.nrv || 0) / 100).toFixed(3) + ')"></i></div>' +
          '<div class="cm">' + esc(n.cm) + '</div></div>';
      }).join('') : '<div class="you-empty">这次没取到营养成分表数字，不猜，只按配料表说。</div>') +
      (nuts.length ? '<div class="note">百分比为 NRV%，指一瓶占每日参考摄入量的比例，不是「健康程度」。</div>' : '') +
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
      '<div class="note">通用饮食常识的演示整理，不构成医疗建议；疾病、孕期与用药请遵医嘱。过敏原请在「偏好」里勾选，「为你」会单独提醒。</div>';
  }

  function renderBuzz(p) {
    var b = p.buzz;
    if (!b) {
      $('#pBuzz').innerHTML = '<div class="you-empty">没有这款的风味与话题档案。演示阶段不生成网友评价，识别到新商品后由后端实时检索。</div>';
      return;
    }
    var q = encodeURIComponent(p.name);
    $('#pBuzz').innerHTML = '<div class="sect-t">口味风味</div>' +
      '<div class="flavs">' + b.flavor.map(function (f) { return '<span class="pill none">' + esc(f) + '</span>'; }).join('') + '</div>' +
      '<div class="sect-t">网上在讨论什么</div>' +
      b.topics.map(function (t) {
        return '<div class="you-item"><div class="h">' + esc(t.t) + '</div><div class="d">' + esc(t.d) + '</div></div>';
      }).join('') +
      '<div class="sect-t buzz-real">去看真实讨论</div>' +
      '<div class="buzz-links">' +
      '<a class="btn flat" target="_blank" rel="noopener" href="https://www.baidu.com/s?wd=' + q + '%20%E8%AF%84%E4%BB%B7">百度搜评价</a>' +
      '<a class="btn flat" target="_blank" rel="noopener" href="https://www.bing.com/search?q=' + q + '%20%E5%8F%A3%E5%91%B3">Bing 搜口味</a>' +
      '<a class="btn flat" target="_blank" rel="noopener" href="https://www.xiaohongshu.com/search_result?keyword=' + q + '">小红书搜笔记</a>' +
      '</div>' +
      '<div class="note">风味与话题为演示归纳，非实时抓取；这里没有编造网友原话、评分或热度数字，真实评价点上方链接。接后端后由「买家秀」实时检索替换。</div>';
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
      html = '<div class="you-empty">还没告诉我们要照顾谁。<br>点右上角<b>偏好</b>勾一下（控糖、乳糖不耐、给孩子买…），这里就会只挑跟你有关的说。</div>';
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
          : '<div class="you-empty">按你勾的情况没有特别要提醒的，这瓶对你没有明显冲突。</div>';
      }
    }
    $('#pYou').innerHTML = html;
    var yn = hits.length + algHits.length;
    $('#youDot').hidden = !yn;
    $('#youDot').textContent = yn ? '(' + yn + ')' : '';
  }

  function switchTab(name) {
    state.tab = name;
    $$('#tabs .tab').forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    $$('.panel').forEach(function (p) { p.classList.toggle('on', p.dataset.panel === name); });
    syncHash();
  }

  /* ---------------- 偏好抽屉 ---------------- */
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
    paper: 'oklch(17% 0.008 250)', panel: 'oklch(21% 0.009 250)', deep: 'oklch(13.5% 0.007 250)',
    ink: 'oklch(95% 0.005 250)', ink2: 'oklch(83% 0.008 250)', muted: 'oklch(71% 0.01 250)',
    rule: 'oklch(31% 0.01 250)',
    amber: 'oklch(82% 0.15 80)', cool: 'oklch(77% 0.12 245)',
    ok: 'oklch(76% 0.15 150)', bad: 'oklch(70% 0.17 25)', badSoft: 'oklch(24.5% 0.035 25)'
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
    $('#btnNext').addEventListener('click', function () { stopCamera(); showView('viewHome'); });
    $('#btnShare').addEventListener('click', function () {
      if (!state.product) return;
      drawCard(state.product); openSheet($('#shareSheet'));
    });
    $('#btnSaveCard').addEventListener('click', saveCard);

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
      var sh = $$('.sheet').filter(function (s) { return !s.hidden; })[0];
      if (!sh) return;
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(sh); return; }
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
})();
