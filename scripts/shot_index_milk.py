"""用 Edge 的 CDP 接口截图商品索引：点「乳制品」筛选后截一张，专门看伊利那几行。

用法：python scripts/shot_index_milk.py [页面地址] [输出文件]
默认 http://127.0.0.1:8091/ → shots/index-milk-fixed.png；
线上验收：python scripts/shot_index_milk.py https://182-92-231-87.sslip.io/ shots/live-index-milk.png
需要目标地址上已跑起 app.backend.main。
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8091/"
OUT = (sys.argv[2] if len(sys.argv) > 2 else
       os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "shots", "index-milk-fixed.png"))
PORT = 9222


def cdp(ws, mid, method, params=None):
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg


def main():
    profile = tempfile.mkdtemp(prefix="edge-shot-")
    proc = subprocess.Popen([EDGE, "--headless=new", "--disable-gpu", "--no-first-run",
                             "--remote-debugging-port=%d" % PORT,
                             "--user-data-dir=" + profile,
                             "--window-size=1200,1150", URL],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    target = None
    for _ in range(40):
        time.sleep(0.5)
        try:
            data = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT, timeout=2))
        except Exception:
            continue
        for t in data:
            if t.get("type") == "page" and str(t.get("url", "")).startswith(URL):
                target = t
                break
        if target:
            break
    if not target:
        raise SystemExit("没找到页面 target")

    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=40)
    cdp(ws, 1, "Page.enable")

    # 等索引真的渲染出来（线上要联网抓热度，比本地慢）
    ready = """
    (function () {
      return !!(document.querySelector('#idxChips .chip') &&
                document.querySelectorAll('#idxList .demo-item').length);
    })()
    """
    for i in range(20):
        time.sleep(1)
        r = cdp(ws, 10 + i, "Runtime.evaluate", {"expression": ready, "returnByValue": True})
        if r.get("result", {}).get("result", {}).get("value"):
            break
    time.sleep(1)

    # 点「乳制品」筛选，再把索引卡片滚到视口顶部
    expr = """
    (function () {
      var chip = Array.prototype.filter.call(document.querySelectorAll('#idxChips .chip'),
        function (b) { return b.dataset.tag === '乳制品'; })[0];
      if (chip) chip.click();
      var card = document.querySelector('#idxList');
      if (card) { var r = card.getBoundingClientRect(); window.scrollBy(0, r.top - 260); }
      return chip ? 'clicked' : 'no-chip';
    })()
    """
    res = cdp(ws, 2, "Runtime.evaluate", {"expression": expr, "returnByValue": True})
    print("click:", res.get("result", {}).get("result", {}).get("value"))
    time.sleep(1.2)

    shot = cdp(ws, 3, "Page.captureScreenshot", {"format": "png"})
    raw = base64.b64decode(shot["result"]["data"])
    with open(OUT, "wb") as f:
        f.write(raw)
    print("saved", OUT, len(raw), "bytes")

    ws.close()
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
