import io

p = 'app/frontend/app.js'
s = io.open(p, encoding='utf-8').read()

pairs = [
    ("        analyzeBarcodeWeb({ name: b.dataset.w, brand: '' }, '');",
     "        analyzeBarcodeWeb({ name: b.dataset.w, brand: '' }, '', 'name');"),
    ("      analyzeBarcodeWeb({ name: nm, brand: br }, '');",
     "      analyzeBarcodeWeb({ name: nm, brand: br }, '', 'name');"),
    ("                  analyzeBarcodeWeb({ name: parsed.name, brand: parsed.brand }, '');",
     "                  analyzeBarcodeWeb({ name: parsed.name, brand: parsed.brand }, '', 'name');"),
    ("      else if (via === 'index') text = '商品索引 · 库内商品';",
     "      else if (via === 'index') text = '商品索引 · 库内商品';\n"
     "      else if (via === 'name') text = '按商品名联网查询 · 未经条码确认';"),
]

for a, b in pairs:
    if a not in s:
        print('MISS:', a[:70])
    else:
        s = s.replace(a, b, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('done')
