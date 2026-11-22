import io

p = 'app/frontend/app.js'
s = io.open(p, encoding='utf-8').read()

pairs = [
    # handleScanResult 增加来源参数
    ('  function handleScanResult(d, code) {',
     "  function handleScanResult(d, code, via) {\n    via = via || 'barcode';"),
    # 内置命中 / 配料直读 / 联网查配料 都带上来源
    ("        if (local) { toast('条码 ' + code + ' 已匹配'); openResult(local, 'barcode'); return; }",
     "        if (local) { toast('条码 ' + code + ' 已匹配'); openResult(local, via); return; }"),
    ("      }, 'barcode');\n        return;",
     "      }, via);\n        return;"),
    ("        analyzeBarcodeWeb(prod, code);",
     "        analyzeBarcodeWeb(prod, code, via);"),
    # analyzeBarcodeWeb 透传来源
    ('  function analyzeBarcodeWeb(prod, code) {',
     '  function analyzeBarcodeWeb(prod, code, via) {'),
    ("        if (d && d.verdict && d.ingredients) { openResult(d, 'barcode'); }",
     "        if (d && d.verdict && d.ingredients) { openResult(d, via || 'barcode'); }"),
    # 首页商品索引：来源标成 index
    ("            }, 'demo');", "            }, 'index');"),
    ('      .then(function (d) { handleScanResult(d, code); })',
     "      .then(function (d) { handleScanResult(d, code, 'index'); })"),
]

for a, b in pairs:
    if a not in s:
        print('MISS:', a[:70].replace('\n', ' '))
    else:
        s = s.replace(a, b, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('done')
