const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
const root = path.resolve(__dirname, '..', '..');
const glossary = require(path.join(root, 'app', 'frontend', 'ingredient-glossary.js'));
require(path.join(root, 'app', 'frontend', 'mock.js'));
const demo = global.window.DEMO;
const review = JSON.parse(fs.readFileSync(path.join(root, 'data', 'ingredient_glossary', 'glossary.review.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(root, 'data', 'ingredient_glossary', 'build_report.json'), 'utf8'));

assert.equal(glossary.entries.length, 143);
assert.equal(review.entries.length, 143);
assert.equal(report.lookup_surfaces, 192);
assert.deepEqual(report.entity_types, { additive: 86, allergen: 7, ingredient: 43, nutrition: 5, processing_related: 2 });
assert.equal(report.cautions_withheld, 143);
assert.equal(report.blank_chemical_information, 143);
assert.equal(report.blank_evidence, 143);
assert.ok(glossary.entries.every(entry => !Object.hasOwn(entry, 'caution')));

assert.equal(glossary.lookup('TBHQ').name, '特丁基对苯二酚');
assert.equal(glossary.lookup(' tbhq ').name, '特丁基对苯二酚');
assert.equal(glossary.lookup('抗坏血酸').name, '维生素C');
assert.equal(glossary.lookup('维生素C（抗坏血酸）').name, '维生素C');
assert.equal(glossary.lookup('谷氨酸钠').name, '味精');
for (const alias of ['果糖', '奶粉', '鲜牛奶', '游离糖', '食用蓝色2号', '内酯', '牛油']) {
  assert.equal(glossary.lookup(alias), null, `过宽别名不应匹配：${alias}`);
}
assert.equal(glossary.lookup('完全不存在的配料'), null);

const dehydroacetate = glossary.lookup('脱氢乙酸钠');
assert.ok(dehydroacetate.uses.includes('腌渍蔬菜'));
assert.ok(!dehydroacetate.uses.includes('面包'));
assert.ok(!dehydroacetate.uses.includes('糕点'));
assert.ok(glossary.lookup('丙酸钙').what.includes('不作为补钙用途'));
assert.ok(!glossary.lookup('丙酸钙').what.includes('还能补一点钙'));
assert.equal(glossary.lookup('乳').entity_type, 'allergen');
assert.equal(glossary.lookup('钠').entity_type, 'nutrition');
assert.equal(glossary.lookup('铝').entity_type, 'processing_related');

const runtimeText = JSON.stringify(glossary.entries);
for (const text of ['婴幼儿食品不允许添加', '辅助降血脂', '合规量是安全的', '没什么特别要注意的', '孕妇儿童少吃']) {
  assert.ok(!runtimeText.includes(text), `未审核注意事项不得进入运行时：${text}`);
}
assert.ok(review.entries.some(entry => entry.original['注意事项（谁要注意）'].includes('婴幼儿食品不允许添加')));

const result = demo.fromText('配料表：脱氢乙酸钠、抗坏血酸、 TBHQ 、完全不存在的配料');
assert.equal(result.ingredients.length, 4);
assert.equal(result.keys[1].v, '3');
assert.equal(result.ingredients[0].what, dehydroacetate.what);
assert.equal(result.ingredients[1].name, '抗坏血酸');
assert.equal(result.ingredients[1].what, glossary.lookup('维生素C').what);
assert.equal(result.ingredients[2].role, '抗氧化剂');
assert.equal(result.ingredients[3].role, '待解读');
assert.equal(result.ingredients[3].caution, '');
assert.ok(result.ingNote.includes('不据此判断合法用量或个体健康风险'));
assert.ok(demo.fromText('水').ingredients[0].what.includes('排第一位'));

console.log('Ingredient glossary tests passed: 143 entries, 192 exact surfaces, fallback integration verified.');
