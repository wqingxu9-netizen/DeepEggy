import io

p = 'app/backend/main.py'
s = io.open(p, encoding='utf-8').read()

pairs = [
    ('"6902000100029": {"id": "maidong", "name": "脉动 水蜜桃口味维生素饮料", "brand": "脉动",',
     '"6902000100029": {"demo": 1, "id": "maidong", "name": "脉动 水蜜桃口味维生素饮料", "brand": "脉动",'),
    ('"6970220100058": {"id": "yuanqi", "name": "元气森林 白桃味气泡水", "brand": "元气森林",',
     '"6970220100058": {"demo": 1, "id": "yuanqi", "name": "元气森林 白桃味气泡水", "brand": "元气森林",'),
]
for a, b in pairs:
    if a not in s:
        print('MISS:', a[:50])
    else:
        s = s.replace(a, b, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('done')
