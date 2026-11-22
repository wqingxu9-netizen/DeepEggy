/* 本地商品条码识别。数字校验仅排除部分误读，并不证明商品真实或数据正确。 */
(function (root) {
  'use strict';
  var nativeFormats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'];
  var nativePromise = null;

  function normalize(value) {
    return String(value == null ? '' : value).normalize('NFKC').replace(/[\s-]/g, '');
  }
  function isValid(value) {
    var s = normalize(value);
    if (!/^(?:\d{8}|\d{12,14})$/.test(s) || !/[1-9]/.test(s)) return false;
    var total = 0;
    for (var i = s.length - 2, n = 0; i >= 0; i--, n++) total += Number(s[i]) * (n % 2 ? 1 : 3);
    return (total + Number(s[s.length - 1])) % 10 === 0;
  }
  function expandUPCE(value) {
    var s = normalize(value);
    if (!/^[01]\d{7}$/.test(s)) return null;
    var n = s[0], d = s.slice(1, 7), check = s[7], last = d[5], expanded;
    if ('012'.indexOf(last) !== -1) expanded = n + d.slice(0, 2) + last + '0000' + d.slice(2, 5) + check;
    else if (last === '3') expanded = n + d.slice(0, 3) + '00000' + d.slice(3, 5) + check;
    else if (last === '4') expanded = n + d.slice(0, 4) + '00000' + d[4] + check;
    else expanded = n + d.slice(0, 5) + '0000' + last + check;
    return isValid(expanded) ? expanded : null;
  }
  function normalizeDetected(value, format) {
    var s = normalize(value);
    if (String(format).toLowerCase().replace(/[-_ ]/g, '') === 'upce') return expandUPCE(s);
    return isValid(s) ? s : null;
  }

  function nativeDetector() {
    if (nativePromise) return nativePromise;
    nativePromise = (async function () {
      if (!('BarcodeDetector' in root)) return null;
      try {
        var formats = nativeFormats;
        if (typeof root.BarcodeDetector.getSupportedFormats === 'function') {
          var available = await root.BarcodeDetector.getSupportedFormats();
          formats = formats.filter(function (f) { return available.indexOf(f) >= 0; });
        }
        return formats.length ? new root.BarcodeDetector({ formats: formats }) : null;
      } catch (_) { return null; }
    })();
    return nativePromise;
  }

  function getSize(source) {
    return { w: source.videoWidth || source.naturalWidth || source.width || 0,
             h: source.videoHeight || source.naturalHeight || source.height || 0 };
  }
  function canvasFor(source, config) {
    var size = getSize(source), crop = config.crop || [0, 0, 1, 1];
    var sx = Math.floor(size.w * crop[0]), sy = Math.floor(size.h * crop[1]);
    var sw = Math.max(1, Math.floor(size.w * crop[2])), sh = Math.max(1, Math.floor(size.h * crop[3]));
    var scale = Math.min(1, (config.limit || 1600) / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    var rotated = config.rotate === 90 || config.rotate === 270;
    var canvas = document.createElement('canvas');
    canvas.width = rotated ? h : w; canvas.height = rotated ? w : h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    if (config.rotate) ctx.rotate(config.rotate * Math.PI / 180);
    if (config.contrast && 'filter' in ctx) ctx.filter = 'contrast(145%)';
    ctx.drawImage(source, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    return canvas;
  }
  function createReader(harder) {
    var z = root.ZXing;
    if (!z) return null;
    var hints = new Map();
    hints.set(z.DecodeHintType.POSSIBLE_FORMATS, [z.BarcodeFormat.EAN_13, z.BarcodeFormat.EAN_8,
      z.BarcodeFormat.UPC_A, z.BarcodeFormat.UPC_E, z.BarcodeFormat.ITF]);
    if (harder) hints.set(z.DecodeHintType.TRY_HARDER, true);
    var reader = new z.MultiFormatReader(); reader.setHints(hints);
    return { reader: reader, hints: hints };
  }
  // A conservative fallback for ITF-14: guard patterns, quiet zones, check
  // digit, and agreement across three independent horizontal image rows.
  function decodeItf14(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true }), w = canvas.width, h = canvas.height;
    if (!ctx || w < 100 || h < 10) return null;
    var digits = { '00110':'0','10001':'1','01001':'2','11000':'3','00101':'4',
      '10100':'5','01100':'6','00011':'7','10010':'8','01010':'9' };
    var votes = {};
    for (var row = 0; row < 5; row++) {
      var y = Math.min(h - 1, Math.floor(h * (0.36 + row * 0.07)));
      var rgba = ctx.getImageData(0, y, w, 1).data, gray = new Uint8Array(w), low = 255, high = 0;
      for (var x = 0; x < w; x++) {
        var k = x * 4, value = (rgba[k] * 77 + rgba[k + 1] * 150 + rgba[k + 2] * 29) >> 8;
        gray[x] = value; low = Math.min(low, value); high = Math.max(high, value);
      }
      if (high - low < 45) continue;
      var threshold = (low + high) / 2, runs = [], black = gray[0] < threshold, start = 0;
      for (var pos = 1; pos <= w; pos++) {
        var next = pos < w && gray[pos] < threshold;
        if (pos === w || next !== black) { runs.push({ black: black, len: pos - start }); start = pos; black = next; }
      }
      var foundInRow = {};
      for (var i = 1; i + 77 < runs.length; i++) {
        if (!runs[i].black || runs[i - 1].black) continue;
        var first = runs.slice(i, i + 4).map(function (a) { return a.len; });
        var unit = (first[0] + first[1] + first[2] + first[3]) / 4;
        if (unit < 1.5 || Math.max.apply(null, first) > unit * 1.7 ||
            Math.min.apply(null, first) < unit * 0.35 || runs[i - 1].len < unit * 5) continue;
        var end = runs.slice(i + 74, i + 77).map(function (a) { return a.len; });
        if (end[0] < unit * 1.5 || end[0] > unit * 4 || end[1] > unit * 1.8 ||
            end[2] > unit * 1.8 || runs[i + 77].len < unit * 5) continue;
        var code = '', wideTotal = 0, narrowTotal = 0;
        for (var pair = 0; pair < 7; pair++) {
          var seq = runs.slice(i + 4 + pair * 10, i + 14 + pair * 10), decoded = [];
          for (var side = 0; side < 2; side++) {
            var lengths = seq.filter(function (_, j) { return j % 2 === side; }).map(function (a) { return a.len; });
            var sorted = lengths.slice().sort(function (a, b) { return a - b; });
            if (sorted.length !== 5 || sorted[3] < sorted[2] * 1.15) { decoded = []; break; }
            var pattern = lengths.map(function (v) { return v > unit * 1.55 ? '1' : '0'; }).join('');
            if (!Object.prototype.hasOwnProperty.call(digits, pattern)) { decoded = []; break; }
            for (var n = 0; n < 5; n++) { if (pattern[n] === '1') wideTotal += lengths[n]; else narrowTotal += lengths[n]; }
            decoded.push(digits[pattern]);
          }
          if (decoded.length !== 2) { code = ''; break; }
          code += decoded.join('');
        }
        if (code.length === 14 && isValid(code) && (wideTotal / 28) / (narrowTotal / 42) >= 1.6) foundInRow[code] = true;
      }
      Object.keys(foundInRow).forEach(function (code) { votes[code] = (votes[code] || 0) + 1; });
    }
    var matches = Object.keys(votes).filter(function (code) { return votes[code] >= 3; });
    return matches.length === 1 ? { code: matches[0], engine: '本地 ITF 复核', needsConfirmation: true } : null;
  }
  function decodeCanvas(canvas, decoder) {
    if (!canvas || !decoder) return null;
    try {
      var z = root.ZXing, luminance = new z.HTMLCanvasElementLuminanceSource(canvas);
      var bitmap = new z.BinaryBitmap(new z.HybridBinarizer(luminance));
      var result = decoder.reader.decodeWithState(bitmap);
      var format = result.getBarcodeFormat();
      var code = format === z.BarcodeFormat.UPC_E ? expandUPCE(result.getText()) : normalizeDetected(result.getText(), '');
      if (code) return { code: code, engine: 'ZXing', needsConfirmation: format === z.BarcodeFormat.ITF };
    } catch (_) { /* Other decoders and the conservative ITF pass follow. */ }
    try { return decodeItf14(canvas); } catch (_) { return null; }
  }
  function createScanner() {
    var fast = createReader(false), thorough = createReader(true), frame = 0;
    return {
      available: function () { return !!fast || ('BarcodeDetector' in root); },
      detect: async function (source, deep) {
        var size = getSize(source);
        if (!size.w || !size.h) return null;
        var detector = await nativeDetector();
        if (detector) {
          try {
            var results = await detector.detect(source);
            for (var j = 0; j < results.length; j++) {
              var code = normalizeDetected(results[j].rawValue, results[j].format || '');
              if (code) return { code: code, engine: '系统识别', needsConfirmation: results[j].format === 'itf' };
            }
          } catch (_) { /* 原生识别失败时仍尝试本地解码器。 */ }
        }
        if (!fast) return null;
        frame++;
        var strategies = deep ? [
          { limit: 2200 }, { limit: 2000, crop: [0.08, 0.15, 0.84, 0.7] },
          { limit: 2000, rotate: 90 }, { limit: 2000, rotate: 270 },
          { limit: 2000, rotate: 180 }, { limit: 2000, contrast: true }
        ] : [ { limit: 1280, crop: [0.06, 0.16, 0.88, 0.68] } ];
        if (!deep && frame % 3 === 0) strategies.push({ limit: 1280 });
        for (var i = 0; i < strategies.length; i++) {
          var result = decodeCanvas(canvasFor(source, strategies[i]), deep ? thorough : fast);
          if (result) return result;
        }
        return null;
      }
    };
  }
  root.DeepEggyBarcode = { normalize: normalize, isValid: isValid, expandUPCE: expandUPCE, createScanner: createScanner };
})(typeof window !== 'undefined' ? window : globalThis);
