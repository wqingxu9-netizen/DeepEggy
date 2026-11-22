/* 商品条码校验和 UPC-E 展开：可用 node app/tests/test_barcode.js 运行。 */
const assert = require('node:assert/strict');
require('../frontend/barcode-scanner.js');
const b = globalThis.DeepEggyBarcode;
assert.equal(b.normalize(' ６９０-７９９２１０００１２ '), '6907992100012');
for (const s of ['6907992100012', '6901010117440', '96385074', '036000291452', '0036000291452', '12345678901231']) {
  assert.equal(b.isValid(s), true, s);
}
for (const s of ['', 'abc', '6907992100013', '0000000000000', '1234567', '6902000100029']) {
  assert.equal(b.isValid(s), false, s);
}
assert.equal(b.expandUPCE('04252614'), '042100005264');
assert.equal(b.expandUPCE('04252615'), null);
assert.equal(b.expandUPCE('24252614'), null);
console.log('Barcode validation and UPC-E expansion tests passed.');
