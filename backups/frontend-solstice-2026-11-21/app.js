/* 看得懂的配料表，DeepEggy 前端逻辑
   零构建原生 JS。演示阶段数据来自 mock.js，接口对齐后替换 loadProduct()。 */

(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var LS_PREF = 'dg_prefs', LS_ALLERGY = 'dg_allergies', LS_HIST = 'dg_history';

  var PREF_TAGS = ['控糖', '减脂', '高血压', '糖尿病', '高尿酸/痛风', '乳糖不耐',
                   '肠胃敏感', '孕期', '给孩子买', '给长辈买', '素食', '过敏体质'];
  var ALLERGENS = ['牛奶', '鸡蛋', '花生', '大豆', '坚果', '麸质/小麦', '海鲜'];
  var ALLERGEN_SOURCE = {
    '牛奶': ['生牛乳', '乳粉', '炼乳', '稀奶油', '乳清'],
    '鸡蛋': ['蛋', '卵磷脂'],
    '花生': ['花生'],
    '大豆': ['大豆', '卵磷脂'],
    '坚果': ['坚果', '杏仁', '腰果'],
    '麸质/小麦': ['小麦', '麸质', '麦芽', '燕麦'],
    '海鲜': ['鱼', '虾', '贝', '海藻', '卡拉胶']
  };

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
    syncHash();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 当前屏与商品写进地址栏：可以转发给队友，浏览器返回也回得到
  function syncHash() {
    var names = { viewHome: 'home', viewScan: 'scan', viewFix: 'fix', viewResult: 'result' };
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
    if (kind === 'fix') {
      var d = window.DEMO.list.filter(function (x) { return x.id === 'milktea'; })[0];
      state.mode = 'label';
      state.ocrDraft = { text: d.ocrText, lowConf: d.lowConf, guess: d };
      showFix();
      return true;
    }
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
  function openSheet(el) { el.hidden = false; }
  function closeSheet(el) { el.hidden = true; }

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
    } else {
      toast('条码 ' + code + ' 演示库里没有，改走「拍配料表」');
      startLabelFlow(null);
    }
  }

  /* ---------------- 拍配料表 / 修正 ---------------- */
  function startLabelFlow(file) {
    state.mode = 'label';
    showView('viewScan');
    $('#scanMode').style.display = 'none';
    $('#scanTip').textContent = '选一张配料表照片（或拍一张）';
    setShot(file);
    fakeOcr();
  }

  // 只有真的拿到照片才插 <img>，不放没有源的图
  function setShot(file) {
    var host = $('#viewFix .fixhead');
    var old = document.getElementById('fixShot');
    if (old) old.parentNode.removeChild(old);
    if (!file || !host) return;
    var im = document.createElement('img');
    im.id = 'fixShot'; im.className = 'shot'; im.width = 420; im.height = 280;
    im.alt = '你上传的配料表照片，用于核对识别结果';
    im.src = URL.createObjectURL(file);
    host.parentNode.insertBefore(im, host.nextSibling);
  }

  function byId(id) {
    var hit = window.DEMO.list.filter(function (x) { return x.id === id; });
    return hit[0] || window.DEMO.list[0];
  }

  // 演示用：真实 OCR 接入后这一步换成 POST /api/analyze
  function fakeOcr() {
    $('#scanTip').textContent = '识别中…';
    setTimeout(function () {
      var p = byId('milktea');
      state.ocrDraft = { text: p.ocrText, lowConf: p.lowConf, guess: p };
      showFix();
    }, 700);
  }

  function showFix() {
    showView('viewFix');
    $('#fixText').value = state.ocrDraft.text;
    growFix();
    $('#lowConf').innerHTML = state.ocrDraft.lowConf.map(function (t) {
      return '<button class="wc" data-w="' + esc(t) + '">不确定：' + esc(t) + '</button>';
    }).join('');
    $$('#lowConf .wc').forEach(function (b) {
      b.addEventListener('click', function () {
        var ta = $('#fixText'), i = ta.value.indexOf(b.dataset.w);
        ta.focus();
        if (i >= 0) { ta.setSelectionRange(i, i + b.dataset.w.length); toast('已定位到这个词，直接改'); }
        else { toast('识别文本里没有这个词'); }
      });
    });
    countItems();
  }

  function growFix() {
    var ta = $('#fixText');
    ta.style.height = 'auto';
    ta.style.height = Math.max(128, ta.scrollHeight + 2) + 'px';
  }

  function countItems() {
    var raw = $('#fixText').value.replace(/配料表[:：]?/g, '');
    var n = raw.split(/[、,，;；\n]/).filter(function (x) {
      var t = x.trim();
      return t && t !== '配料表';
    }).length;
    $('#fixCount').textContent = n + ' 项';
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
        return '<div class="ing" data-i="' + i + '">' +
          '<button class="ing-h"><span class="bul ' + esc(it.flag) + '"></span>' +
          '<span class="nm">' + esc(it.name) + '</span><span class="role">' + esc(it.role || '') + '</span>' +
          '<span class="car" aria-hidden="true"></span></button>' +
          '<div class="ing-b"><div class="what">' + esc(it.what) + '</div>' +
          (it.why ? '<div class="why">' + esc(it.why) + '</div>' : '') +
          dose +
          (it.caution ? '<div class="cau"><b>留意</b>' + esc(it.caution) + '</div>' : '') +
          '</div></div>';
      }).join('') +
      '<div class="note">' + esc(p.ingNote || '顺序即含量顺序：排在前面的占比大，排在后面的通常不到 2%。') + '</div>';

    $$('#pIng .ing-h').forEach(function (h) {
      h.addEventListener('click', function () { h.parentNode.classList.toggle('open'); });
    });
    var first = $('#pIng .ing');
    if (first) first.classList.add('open');
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
    if (!t) { $('#pTrace').innerHTML = '<div class="you-empty">这一项要联网检索官网与产地公示，演示阶段没有数据。</div>'; return; }
    var c = p.compare;
    $('#pTrace').innerHTML = '<div class="sect-t">溯源，联网搜官网</div>' +
      '<div class="trace' + (t.found ? '' : ' miss') + '">' +
      '<div class="st">' + (t.found ? '<span class="ok">官网可查</span>' : '<span class="no">官网无数据</span>') +
      '<span class="mono">' + esc(t.source) + '</span></div>' +
      '<div class="pl">' + esc(t.place) + '</div>' +
      '<ul class="lns">' + (t.lines || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
      '<div class="src">' + esc(t.note) + '</div></div>' +
      (t.found ? '' : '<div class="note">溯源取不到数据时，本页结论只基于配料表与营养成分表，不做产地判断：宁可少说，不编。</div>') +
      (c ? '<div class="cmp"><div class="sect-t">同类对比：' + esc(c.metric) + '</div>' +
      c.rows.map(function (r) {
        var max = Math.max.apply(null, c.rows.map(function (x) { return x.value; })) || 1;
        return '<div class="cmp-row' + (r.me ? ' me' : '') + '"><span class="cn">' + esc(r.name) + '</span>' +
          '<span class="cb"><i style="transform:scaleX(' + (Math.round(r.value / max * 100) / 100).toFixed(3) + ')"></i></span>' +
          '<span class="cv">' + r.value.toFixed(1) + '</span></div>';
      }).join('') +
      '<div class="note">同类数据来自演示库，后端接入后按知识库实时检索。</div></div>' : '');
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

  function renderYou(p) {
    var prefs = read(LS_PREF, []), algs = read(LS_ALLERGY, []);
    var hits = (p.health || []).filter(function (h) {
      var parts = h.tag.split('/').map(function (x) { return x.trim(); });
      return prefs.some(function (t) {
        var tp = t.split('/').map(function (x) { return x.trim(); });
        return parts.some(function (a) { return tp.some(function (b) { return a.indexOf(b) !== -1 || b.indexOf(a) !== -1; }); });
      });
    });

    var algHits = [];
    algs.forEach(function (a) {
      var src = ALLERGEN_SOURCE[a] || [];
      p.ingredients.forEach(function (i) {
        if (src.some(function (k) { return i.name.indexOf(k) !== -1; })) algHits.push({ a: a, n: i.name });
      });
    });

    var html = '';
    if (!prefs.length && !algs.length) {
      html = '<div class="you-empty">还没告诉我们要照顾谁。<br>点右上角<b>偏好</b>勾一下（控糖、乳糖不耐、给孩子买…），这里就会只挑跟你有关的说。</div>';
    } else {
      if (algHits.length) {
        html += '<div class="sect-t">过敏原命中</div>' +
          algHits.map(function (h) {
            return '<div class="you-item risk"><div class="h"><span class="tag pill bad">过敏</span>' +
              esc(h.a) + '，配料里写作' + esc(h.n) + '</div><div class="d">配料里有这个，建议直接放下。</div></div>';
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
    $$('#tabs .tab').forEach(function (t) { t.classList.toggle('on', t.dataset.tab === name); });
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
    $('#allergyChips').innerHTML = ALLERGENS.map(function (t) {
      var on = algs.indexOf(t) !== -1;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-a="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
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
    $$('#allergyChips .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        var v = c.dataset.a, a = read(LS_ALLERGY, []), i = a.indexOf(v);
        if (i === -1) a.push(v); else a.splice(i, 1);
        store(LS_ALLERGY, a); renderPrefs(); if (state.product) renderYou(state.product);
      });
    });
  }

  /* ---------------- 分享卡片 ---------------- */
  // 卡片用 SOL 常量（与 tokens.css 的 Solstice 调色板一一对应），Canvas 里读不了 CSS 变量
  var SOL = {
    paper: '#f6f1e3', well: '#fbf8ef', edge: '#ece2cc', rule: '#e3d4ab', gold: '#c9a24a',
    ink: '#4a3f35', ink2: '#5f5142', muted: '#7d6a5a', vermilion: '#cf4b2c',
    inkBar: '#5f5142', gold: '#c9a24a'
  };
  var Fdisp = '"Yeseva One","Songti SC","SimSun",serif';
  var Fbody = '"Archivo","PingFang SC","Microsoft YaHei",sans-serif';
  var Fsmall = '"Archivo Narrow","PingFang SC",sans-serif';

  function drawCard(p) {
    var c = $('#shareCanvas');
    var W = 900, H = 1200;
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    var tone = p.verdict.level === 'bad' ? SOL.vermilion : SOL.ink;
    var creditY = 1136;

    x.fillStyle = SOL.paper; x.fillRect(0, 0, W, H);
    x.fillStyle = SOL.well; x.fillRect(40, 40, W - 80, H - 80);
    x.strokeStyle = SOL.ink; x.lineWidth = 3; x.strokeRect(40, 40, W - 80, H - 80);
    x.strokeStyle = SOL.gold; x.lineWidth = 1; x.strokeRect(49, 49, W - 98, H - 98);

    x.fillStyle = SOL.muted; x.font = '600 25px ' + Fsmall;
    x.fillText('DeepEggy 看得懂的配料表', 80, 112);
    x.strokeStyle = SOL.gold; x.beginPath(); x.moveTo(80, 136); x.lineTo(W - 80, 136); x.stroke();

    x.fillStyle = SOL.ink; x.font = '400 50px ' + Fdisp;
    wrap(x, p.name, 80, 200, W - 160, 58);

    x.font = '400 26px ' + Fsmall; x.fillStyle = SOL.muted;
    x.fillText(p.brand + '，' + p.spec + '，' + p.barcode, 80, 300);

    // 印章：方框、硬边、略歪，与页面同一套语言
    x.save(); x.translate(80, 336); x.rotate(-0.028);
    x.strokeStyle = tone; x.fillStyle = tone; x.lineWidth = 5;
    x.font = '400 66px ' + Fdisp;
    var tw = x.measureText(p.verdict.label).width;
    x.strokeRect(0, 0, tw + 52, 96);
    x.globalAlpha = 0.28; x.strokeRect(9, 9, tw + 34, 78); x.globalAlpha = 1;
    x.fillText(p.verdict.label, 26, 70);
    x.restore();

    x.fillStyle = SOL.ink2; x.font = '400 28px ' + Fbody;
    wrap(x, p.verdict.why, 80, 510, W - 160, 42);

    // 三个关键数字：骑缝竖线，不加卡片
    var kw = (W - 160) / p.keys.length;
    p.keys.forEach(function (k, i) {
      var cx = 80 + kw * i;
      if (i > 0) { x.strokeStyle = SOL.rule; x.lineWidth = 1; x.beginPath(); x.moveTo(cx - 6, 604); x.lineTo(cx - 6, 744); x.stroke(); }
      x.fillStyle = k.hi ? SOL.vermilion : SOL.ink;
      x.font = '400 52px ' + Fdisp;
      x.fillText(k.v, cx + (i ? 14 : 0), 672);
      x.fillStyle = SOL.muted; x.font = '600 22px ' + Fsmall;
      x.fillText(k.u, cx + (i ? 14 : 0), 704);
      x.fillStyle = SOL.ink; x.font = '500 25px ' + Fbody;
      x.fillText(k.l, cx + (i ? 14 : 0), 738);
    });

    x.strokeStyle = SOL.gold; x.lineWidth = 1; x.beginPath(); x.moveTo(80, 786); x.lineTo(W - 80, 786); x.stroke();

    x.fillStyle = SOL.muted; x.font = '600 23px ' + Fsmall;
    x.fillText('最需要留意的几项', 80, 826);
    var warns = p.ingredients.filter(function (i) { return i.flag !== 'green'; }).slice(0, 4);
    x.font = '400 26px ' + Fbody;
    warns.forEach(function (w, i) {
      var y = 868 + i * 40;
      x.fillStyle = w.flag === 'red' ? SOL.vermilion : SOL.gold;
      x.fillRect(80, y - 10, 11, 11);
      x.fillStyle = SOL.ink;
      x.fillText(w.name + '（' + (w.role || '') + '）', 106, y);
    });

    var tr = p.tricks.filter(function (t) { return !t.ok && !t.edu; })[0];
    if (tr) {
      var truthTxt = tr.truth.replace(/<[^>]+>/g, '');
      x.font = '400 23px ' + Fbody;
      var lines = splitLines(x, truthTxt, W - 220, 3);
      var boxH = 40 + lines.length * 30 + 10;
      x.fillStyle = SOL.edge; x.fillRect(80, 1000, W - 160, boxH);
      x.fillStyle = SOL.vermilion; x.fillRect(80, 1000, 6, boxH);
      x.fillStyle = SOL.ink; x.font = '500 27px ' + Fbody;
      x.fillText(tr.claim, 104, 1036);
      x.font = '400 23px ' + Fbody; x.fillStyle = SOL.ink2;
      lines.forEach(function (ln, i) { x.fillText(ln, 104, 1068 + i * 30); });
      creditY = 1000 + boxH + 34;
    }

    x.fillStyle = SOL.muted; x.font = '400 21px ' + Fbody;
    x.fillText('首届 AgriHackathon 参赛作品，演示数据，解读依据公开国标，不构成医疗建议', 80, creditY);
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
    $('#btnLabel').addEventListener('click', function () {
      state.mode = 'label';
      $('#imgInput').click();
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
          toast('没抓到条码，改走配料表识别');
          fakeOcr();
        }
      }).catch(function () {
        $('#btnShoot').disabled = false; stopCamera(); fakeOcr();
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
      if (f) startLabelFlow(f);
    });

    $('#fixText').addEventListener('input', function () { countItems(); growFix(); });
    $('#btnFixOk').addEventListener('click', function () {
      var txt = $('#fixText').value;
      var p = window.DEMO.matchByText(txt);
      if (!p) {
        toast('文本里没找到能匹配的商品，走兜底解析');
        p = window.DEMO.fromText(txt);
      }
      openResult(p, 'label');
    });
    $('#btnFixBack').addEventListener('click', function () { stopCamera(); showView('viewHome'); });

    $('#tabs').addEventListener('click', function (e) {
      var t = e.target.closest('.tab'); if (t) switchTab(t.dataset.tab);
    });

    $('#prefBtn').addEventListener('click', function () { renderPrefs(); openSheet($('#prefSheet')); });
    $('#btnNext').addEventListener('click', function () { stopCamera(); showView('viewHome'); });
    $('#btnShare').addEventListener('click', function () {
      if (!state.product) return;
      drawCard(state.product); openSheet($('#shareSheet'));
    });
    $('#btnSaveCard').addEventListener('click', saveCard);

    $$('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { $('#prefSheet').hidden = true; $('#shareSheet').hidden = true; });
    });
    $$('.sheet').forEach(function (sh) {
      sh.addEventListener('click', function (e) { if (e.target === sh) sh.hidden = true; });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopCamera();
    });
  }

  bind();
  renderHome();
  renderPrefs();
  if (!routeFromHash()) showView('viewHome');
})();
