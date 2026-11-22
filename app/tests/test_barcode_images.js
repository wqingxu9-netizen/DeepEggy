/* End-to-end offline decoder checks using synthetic grayscale barcode fixtures.
 * Run: node app/tests/test_barcode_images.js (no third-party test packages).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Minimal pixel canvas for running the real browser decoder against fixtures.
class RasterCanvas {
  constructor() { this.width = 0; this.height = 0; this.ownerDocument = global.document; this.context = new RasterContext(this); }
  getContext() { return this.context; }
}
class RasterContext {
  constructor(canvas) { this.canvas = canvas; this.a=1; this.b=0; this.c=0; this.d=1; this.e=0; this.f=0; this.pixels=null; }
  fillRect() { this.pixels = new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4).fill(255); }
  translate(x,y) { this.e += this.a*x+this.c*y; this.f += this.b*x+this.d*y; }
  rotate(angle) {
    const cos=Math.cos(angle),sin=Math.sin(angle),a=this.a,b=this.b,c=this.c,d=this.d;
    this.a=a*cos+c*sin; this.b=b*cos+d*sin; this.c=-a*sin+c*cos; this.d=-b*sin+d*cos;
  }
  drawImage(source,...args) {
    let sx=0,sy=0,sw=source.width,sh=source.height,dx,dy,dw,dh;
    if (args.length===2) { [dx,dy]=args; dw=sw; dh=sh; }
    else if (args.length===4) { [dx,dy,dw,dh]=args; }
    else { [sx,sy,sw,sh,dx,dy,dw,dh]=args; }
    if (!this.pixels || this.pixels.length!==this.canvas.width*this.canvas.height*4) this.fillRect();
    const src=source.data || source.getContext('2d').pixels, channels=source.data ? 1 : 4;
    const det=this.a*this.d-this.b*this.c,W=this.canvas.width,H=this.canvas.height;
    for(let y=0;y<H;y++) for(let x=0;x<W;x++) {
      const ox=x+.5-this.e,oy=y+.5-this.f;
      const u=(this.d*ox-this.c*oy)/det,v=(-this.b*ox+this.a*oy)/det;
      if(u<dx || v<dy || u>=dx+dw || v>=dy+dh) continue;
      const px=Math.min(source.width-1,Math.max(0,Math.floor(sx+(u-dx)*sw/dw)));
      const py=Math.min(source.height-1,Math.max(0,Math.floor(sy+(v-dy)*sh/dh)));
      const from=(py*source.width+px)*channels,to=(y*W+x)*4;
      if(channels===1) this.pixels[to]=this.pixels[to+1]=this.pixels[to+2]=src[from];
      else { this.pixels[to]=src[from]; this.pixels[to+1]=src[from+1]; this.pixels[to+2]=src[from+2]; }
      this.pixels[to+3]=255;
    }
  }
  getImageData(x,y,w,h) {
    if (!this.pixels) this.fillRect();
    const out=new Uint8ClampedArray(w*h*4);
    for(let row=0;row<h;row++) {
      const start=((y+row)*this.canvas.width+x)*4;
      out.set(this.pixels.subarray(start,start+w*4),row*w*4);
    }
    return { data: out };
  }
}
global.document = { createElement: kind => { assert.equal(kind,'canvas'); return new RasterCanvas(); } };
global.ZXing = require('../frontend/vendor/zxing/index.min.js');
require('../frontend/barcode-scanner.js');

(async () => {
  const folder=path.join(__dirname,'fixtures','barcode');
  const tests=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
  const scanner=global.DeepEggyBarcode.createScanner();
  for(const test of tests) {
    const data=zlib.gunzipSync(fs.readFileSync(path.join(folder,test.name+'.gray.gz')));
    const source={ width:test.width,height:test.height,data };
    const got=await scanner.detect(source,true), value=got ? got.code : '';
    assert.equal(value.padStart(14,'0'),test.expected.padStart(14,'0'),test.name);
    if (test.name.startsWith('ITF_') && test.expected) assert.equal(got.needsConfirmation,true,test.name);
    console.log('PASS',test.name,value || '(no code)',got ? got.engine : '');
  }
  console.log('Synthetic image checks passed:',tests.length);
})().catch(e => { console.error(e); process.exitCode=1; });
