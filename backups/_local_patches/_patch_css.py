import io

p = 'app/frontend/style.css'
css = """

/* 结果卡上的「识别依据」：扫码 / 拍照 / 示例 / 索引 / 按名字查 —— 一眼看出这结果哪来的 */
.rc-from { display: inline-block; margin-top: 8px; padding: 2px 9px; font-size: 12px; line-height: 1.6;
  color: var(--color-muted); border: 1px solid var(--color-rule); border-radius: var(--radius-pill); }
.rc-from.demo { color: var(--color-accent-ink); background: var(--color-accent-soft); border-color: var(--color-accent); }
"""
s = io.open(p, encoding='utf-8').read()
if '.rc-from' not in s:
    s += css
    io.open(p, 'w', encoding='utf-8').write(s)
    print('css appended')
else:
    print('css already has .rc-from')
