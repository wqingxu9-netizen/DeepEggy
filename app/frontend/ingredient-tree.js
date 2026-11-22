/* 配料结构树（DeepEggy）
 *
 * 把「配料表」从一条平铺长列表变成可折叠的结构，且不编造任何信息：
 *   一级：功能分组（团队 143 条审校词条的 category：基础食材 / 基础配料 / 食品添加剂 / 需注意成分）
 *   二级：配料本身（保留配料表原序序号，序号即含量顺序）
 *   三级：复合配料括号内的展开项（只有 OCR 原文里真的写了括号才出现，GB 7718 要求复合配料展开）
 *
 * 数据边界：
 *   - 分组只来自本地词条，词条没有的进「未归类」，不猜、不按正则归类；
 *   - 子项只来自包装原文的括号，不推断「可能含有什么」；
 *   - 本模块不判断安全与否，只决定「怎么摆」，flag/结论仍由后端与词条提供。
 *
 * 对外：window.DG_ING_TREE = { build, parseLabel, norm, CATEGORY_ORDER }
 */
(function (root) {
  'use strict';

  // 展示顺序：先主料，再添加剂，最后未归类（空组由渲染层跳过）
  var CATEGORY_ORDER = ['基础食材', '基础配料', '食品添加剂', '需注意成分', '未归类'];
  var UNKNOWN = '未归类';

  var CATEGORY_NOTE = {
    '基础食材': '团队审校词条 · 常见主料',
    '基础配料': '团队审校词条 · 常见辅料',
    '食品添加剂': '团队审校词条 · 国标功能类别',
    '需注意成分': '团队审校词条 · 需留意项',
    '未归类': '词条与国标库都未收录，不猜'
  };

  // 说明性括号：括号里只有一项、且以这些字开头时，是标注而不是配料展开
  var NOTE_RE = /^[含≥≤＞＜>约以不注：:且或]/;
  var OPEN_RE = /[（(]/;
  var CLOSE_RE = /[）)]/;
  var SEP_RE = /[、,，;；\n]/;

  function norm(value) {
    var s = String(value == null ? '' : value);
    if (s.normalize) { s = s.normalize('NFKC'); }
    s = s.toLowerCase().trim()
      .replace(/^其中[:：]?/, '')
      .replace(/[\s]/g, '')
      .replace(/[（(][^）)]*[）)]/g, '');   // 去掉括号注释后再比：烟酰胺（维生素 B3）→ 烟酰胺
    return s.replace(/[·•・]/g, '');
  }

  function glossaryEntry(name) {
    var g = root.INGREDIENT_GLOSSARY;
    if (!g || !g.lookup) { return null; }
    return g.lookup(name) || null;
  }

  function categoryOf(name) {
    var ent = glossaryEntry(name);
    if (ent && ent.category && CATEGORY_ORDER.indexOf(ent.category) >= 0) { return ent.category; }
    if (ent && ent.category === '基础配料') { return '基础配料'; }
    return UNKNOWN;
  }

  function roleOf(name, fallback) {
    var ent = glossaryEntry(name);
    if (ent && ent.role) { return ent.role; }
    return fallback || '';
  }

  function escHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 复合配料括号展开项：术语有词条的给释义，没有的明说未收录 */
  function subsHtml(subs) {
    if (!subs || !subs.length) { return ''; }
    return '<div class="subs"><div class="subs-t">包装括号里展开的子配料</div><ul>' +
      subs.map(function (c) {
        return '<li><b>' + escHtml(c.name) + '</b>' +
          (c.note ? '<span class="subs-n">' + escHtml(c.note) + '</span>' : '') +
          (c.what ? '<span class="subs-d">' + escHtml(c.what) +
                    (c.uses ? '（常见用途：' + escHtml(c.uses) + '）' : '') + '</span>'
                  : '<span class="subs-d muted">词条未收录，这一项不猜。</span>') +
          '</li>';
      }).join('') + '</ul></div>';
  }

  /* ---------- 标签原文 → 括号树 ----------
     knownNames：本商品已知配料名（归一化后），用来阻止把「单，双甘油脂肪酸酯」这种
     名字里带逗号的配料切开。没有它也能跑，只是会切错。 */
  function parseLabel(text, knownNames) {
    var src = String(text == null ? '' : text)
      .replace(/^[\s\S]*?配料(?:表)?[：:]?/, '')   // 去掉「配料表：」前缀
      .trim();
    if (!src) { return []; }

    var known = {};
    Object.keys(knownNames || {}).forEach(function (k) { known[norm(k)] = true; });
    var pos = 0;

    function peekNextFragment(from) {
      var out = '';
      for (var i = from; i < src.length; i++) {
        var ch = src.charAt(i);
        if (SEP_RE.test(ch) || OPEN_RE.test(ch) || CLOSE_RE.test(ch)) { break; }
        out += ch;
      }
      return out;
    }

    function parseList(depth) {
      var items = [];
      var buf = '';
      var closed = false;

      function push(name, children, note) {
        name = String(name || '').trim();
        if (!name) { return; }
        items.push({ name: name, children: children || [], note: note || '' });
      }

      while (pos < src.length) {
        var ch = src.charAt(pos);

        if (OPEN_RE.test(ch)) {
          var head = buf.trim();
          pos += 1;
          if (!head) {                  // 括号前没有名字：当普通字符，不制造空气节点
            buf += ch;
            continue;
          }
          var sub = parseList(depth + 1);
          if (!sub.closed) {
            // OCR 把右括号吃掉了：不建父子关系（否则会凭空造出层级），
            // 把括号里的内容当标注挂在同名配料上
            push(head, [], sub.items.map(function (n) { return n.name; }).join('、'));
          } else if (sub.items.length === 1 && !sub.items[0].children.length && NOTE_RE.test(sub.items[0].name)) {
            push(head, [], sub.items[0].name);
          } else {
            push(head, sub.items, '');
          }
          buf = '';
          continue;
        }

        if (CLOSE_RE.test(ch)) {
          var name = buf.trim();
          push(name, [], '');
          buf = '';
          pos += 1;
          return { items: items, closed: true };
        }

        if (SEP_RE.test(ch)) {
          var frag = peekNextFragment(pos + 1);
          var merged = frag ? norm(buf + ch + frag) : '';
          // 名字本身带逗号（单，双甘油脂肪酸酯）：不在这里切
          if (buf.trim() && frag && known[merged]) {
            buf += ch;
            pos += 1;
            continue;
          }
          push(buf, [], '');
          buf = '';
          pos += 1;
          continue;
        }

        buf += ch;
        pos += 1;
      }

      push(buf, [], '');
      return { items: items, closed: depth === 0 };
    }

    return parseList(0).items;
  }

  function flattenNames(nodes, out) {
    out = out || [];
    (nodes || []).forEach(function (n) {
      out.push(n.name);
      if (n.children && n.children.length) { flattenNames(n.children, out); }
    });
    return out;
  }

  function findParsed(nodes, key) {
    for (var i = 0; i < nodes.length; i++) {
      if (norm(nodes[i].name) === key) { return nodes[i]; }
      if (nodes[i].children && nodes[i].children.length) {
        var hit = findParsed(nodes[i].children, key);
        if (hit) { return hit; }
      }
    }
    return null;
  }

  /* ---------- 组装视图模型 ---------- */
  function build(product) {
    var items = (product && product.ingredients) || [];
    var known = {};
    items.forEach(function (it) { known[norm(it.name)] = true; });

    var parsed = [];
    var ocr = product && product.ocrText;
    if (ocr) {
      try { parsed = parseLabel(ocr, known); } catch (e) { parsed = []; }
    }

    // 只有原文结构与已知配料对得上才用括号树；对不上就退回平铺，不硬套
    var parsedNames = parsed.length ? flattenNames(parsed).map(norm) : [];
    var matched = items.filter(function (it) { return parsedNames.indexOf(norm(it.name)) >= 0; }).length;
    var useParse = parsed.length > 0 && items.length > 0 && matched / items.length >= 0.6;

    var groups = {};
    var rows = [];

    items.forEach(function (it, index) {
      var cat = categoryOf(it.name);
      var node = useParse ? findParsed(parsed, norm(it.name)) : null;
      var children = [];
      if (node && node.children && node.children.length) {
        children = node.children.map(function (c) {
          var ent = glossaryEntry(c.name);
          return { name: c.name, what: ent ? ent.what : '', uses: ent ? ent.uses : '', note: c.note || '' };
        });
      }
      var row = {
        item: it,
        index: index,
        cat: cat,
        // 优先用后端/示例给的 role（更像「作用」），词条只用来补缺
        role: it.role || roleOf(it.name, ''),
        note: node && node.note ? node.note : '',
        children: children
      };
      rows.push(row);
      if (!groups[cat]) { groups[cat] = []; }
      groups[cat].push(row);
    });

    var out = CATEGORY_ORDER.filter(function (cat) { return groups[cat] && groups[cat].length; })
      .map(function (cat) {
        return {
          key: cat,
          label: cat,
          note: CATEGORY_NOTE[cat] || '',
          rows: groups[cat]
        };
      });

    return {
      groups: out,
      mode: useParse ? 'label' : 'flat',
      stats: {
        total: items.length,
        grouped: items.length - (groups[UNKNOWN] ? groups[UNKNOWN].length : 0),
        unknown: groups[UNKNOWN] ? groups[UNKNOWN].length : 0,
        compound: rows.filter(function (r) { return r.children.length; }).length
      }
    };
  }

  var api = {
    build: build,
    parseLabel: parseLabel,
    subsHtml: subsHtml,
    norm: norm,
    categoryOf: categoryOf,
    CATEGORY_ORDER: CATEGORY_ORDER
  };

  root.DG_ING_TREE = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
