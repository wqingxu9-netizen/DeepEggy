const assert = require('node:assert/strict');
const path = require('node:path');

global.window = {};
const root = path.resolve(__dirname, '..', '..');
const glossary = require(path.join(root, 'app', 'frontend', 'ingredient-glossary.js'));
const tree = require(path.join(root, 'app', 'frontend', 'ingredient-tree.js'));
require(path.join(root, 'app', 'frontend', 'mock.js'));
const demo = global.window.DEMO;

// 1. 括号展开：复合配料挂子项
const t1 = tree.parseLabel(
  '配料表：水、植脂末（葡萄糖浆、植物油、酪蛋白酸钠）、食用香精',
  { '植脂末': true, '葡萄糖浆': true, '植物油': true, '酪蛋白酸钠': true, '水': true, '食用香精': true }
);
assert.equal(t1.length, 3);
assert.equal(t1[1].name, '植脂末');
assert.deepEqual(t1[1].children.map(c => c.name), ['葡萄糖浆', '植物油', '酪蛋白酸钠']);

// 2. 说明性括号：记 note，不建子节点
const t2 = tree.parseLabel('配料表：水、乳清粉（含乳清蛋白≥35%）、食用香精');
assert.equal(t2[1].children.length, 0);
assert.equal(t2[1].note, '含乳清蛋白≥35%');

// 3. 右括号被 OCR 吃掉：不许凭空造父子关系
const t3 = tree.parseLabel('配料表：水、白砂糖（无糖');
assert.equal(t3[1].name, '白砂糖');
assert.equal(t3[1].children.length, 0);
assert.ok(t3[1].note.includes('无糖'));

// 4. 名字里带逗号：单，双甘油脂肪酸酯 不能被切开
const t4 = tree.parseLabel(
  '配料表：水、单，双甘油脂肪酸酯、卡拉胶',
  { '水': true, '单，双甘油脂肪酸酯': true, '卡拉胶': true }
);
assert.deepEqual(t4.map(n => n.name), ['水', '单，双甘油脂肪酸酯', '卡拉胶']);

// 5. 分组：词条有的进对应组，没有的进未归类且不隐藏
const p = demo.list[0];
const built = tree.build(p);
assert.ok(built.groups.length >= 2);
assert.equal(built.stats.total, p.ingredients.length);
const flatRows = built.groups.reduce((acc, g) => acc.concat(g.rows), []);
assert.equal(flatRows.length, p.ingredients.length, '树化不能吞项');
const idx = flatRows.map(r => r.index).sort((a, b) => a - b);
assert.deepEqual(idx, p.ingredients.map((_, i) => i), '每项都要有原序序号');
assert.ok(built.groups.every(g => tree.CATEGORY_ORDER.includes(g.key)));
assert.equal(built.groups[0].key, '基础食材', '基础食材应排在最前');
assert.ok(flatRows.every(r => r.cat && r.role !== undefined));

// 6. 没有 ocrText 时退回平铺（依旧分组，但不假装有括号结构）
const builtFlat = tree.build({ ingredients: p.ingredients });
assert.equal(builtFlat.mode, 'flat');
assert.equal(builtFlat.stats.compound, 0);

// 7. 四款示例商品全部可树化，且数量守恒
for (const product of demo.list) {
  const b = tree.build(product);
  const rows = b.groups.reduce((acc, g) => acc.concat(g.rows), []);
  assert.equal(rows.length, product.ingredients.length, `${product.name} 项数不守恒`);
  assert.ok(rows.every(r => !r.children.some(c => !c.name)));
}

// 8. 分组来源可追溯：未归类项必须带说明
const unknownGroup = tree.build({ ingredients: [{ name: '一种不存在的配料', flag: 'green' }] }).groups;
assert.equal(unknownGroup.length, 1);
assert.equal(unknownGroup[0].key, '未归类');
assert.ok(unknownGroup[0].note.includes('不猜'));

// 9. 子配料渲染：词条有的给释义，没收录的明说，且不把标签当 HTML
const subs = tree.subsHtml([
  { name: '葡萄糖浆', what: '用淀粉做的液态糖', uses: '糖果、糕点' },
  { name: '<img src=x onerror=alert(1)>' }
]);
assert.ok(subs.includes('包装括号里展开的子配料'));
assert.ok(subs.includes('葡萄糖浆'));
assert.ok(subs.includes('词条未收录，这一项不猜'));
assert.ok(!subs.includes('<img'), '子配料名必须转义');
assert.ok(subs.includes('&lt;img'));

// 10. build：复合配料在树里挂上子项
const compound = tree.build({
  ocrText: '配料表：植脂末（葡萄糖浆、植物油、酪蛋白酸钠）、白砂糖',
  ingredients: [
    { name: '植脂末', flag: 'yellow', role: '奶感' },
    { name: '白砂糖', flag: 'yellow', role: '甜味' }
  ]
});
const row = compound.groups.reduce((a, g) => a.concat(g.rows), []).filter(r => r.item.name === '植脂末')[0];
assert.ok(row, '植脂末应出现在树里');
assert.equal(row.children.length, 3);
assert.equal(row.children[0].name, '葡萄糖浆');
assert.ok(row.children[0].what, '子配料应带词条释义');
assert.equal(compound.stats.compound, 1);

console.log('ingredient-tree: 10 组断言全部通过（解析 / 分组 / 子配料 / 转义）');

