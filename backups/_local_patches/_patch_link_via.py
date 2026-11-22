import io

p = 'app/frontend/app.js'
s = io.open(p, encoding='utf-8').read()

a = "      else if (via === 'name') text = '按商品名联网查询 · 未经条码确认';"
b = ("      else if (via === 'name') text = '按商品名联网查询 · 未经条码确认';\n"
     "      else if (via === 'link') text = '分享链接打开';\n"
     "      else text = '识别结果';")

if a in s and "via === 'link'" not in s:
    s = s.replace(a, b, 1)
    io.open(p, 'w', encoding='utf-8').write(s)
    print('patched')
else:
    print('skip', a in s)
