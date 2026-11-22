import io
import re

s = io.open('app/frontend/mock.js', encoding='utf-8').read()
pat = re.compile(r"id:\s*'([^']+)'.*?name:\s*'([^']*)'.*?barcode:\s*'([^']*)'", re.S)
print('--- mock.js 示例商品')
for m in pat.finditer(s):
    print(m.group(1), '|', m.group(2), '|', m.group(3))

t = io.open('app/backend/main.py', encoding='utf-8').read()
i = t.index('PRODUCTS = {')
blk = t[i:t.index('\n    }', i)]
print('--- main.py 内置条码')
for m in re.finditer(r'"(\d{8,14})":\s*\{"id":\s*"([^"]+)",\s*"name":\s*"([^"]+)",\s*"brand":\s*"([^"]+)"', blk):
    print(m.group(1), '|', m.group(2), '|', m.group(3), '|', m.group(4))
