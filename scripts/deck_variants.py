"""遍历 Dashi 预览页的 4 个方案（1/2/3/AI），逐页截图，便于挑最好的那版。

用法：python scripts/deck_variants.py <preview-url> <out-dir> [pages]
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
URL = sys.argv[1]
OUT = sys.argv[2]
PAGES = int(sys.argv[3]) if len(sys.argv) > 3 else 10
CDP_PORT = 9466
VARIANTS = ["1", "2", "3", "AI"]

RECT_JS = """(() => {
  const label = %s;
  const group = Array.from(document.querySelectorAll('[role=group]'))
     .find(g => /版式|配色/.test(g.getAttribute('aria-label') || ''));
  const scope = group ? group : document;
  const b = Array.from(scope.querySelectorAll('button')).find(x => (x.textContent||'').trim() === label);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return {x: r.x + r.width/2, y: r.y + r.height/2};
})()"""


def cdp(ws, mid, method, params=None):
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == mid:
            return r


def click_text(ws, mid, label):
    expr = RECT_JS % json.dumps(label)
    r = cdp(ws, mid, "Runtime.evaluate", {"expression": expr, "returnByValue": True})
    pt = r.get("result", {}).get("result", {}).get("value")
    if not pt:
        return False
    for kind in ("mousePressed", "mouseReleased"):
        cdp(ws, mid + 500, "Input.dispatchMouseEvent",
            {"type": kind, "x": pt["x"], "y": pt["y"], "button": "left", "clickCount": 1})
    return True


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="edge-var-")
    proc = subprocess.Popen([EDGE, "--headless=new", "--disable-gpu", "--no-first-run",
                             "--remote-debugging-port=%d" % CDP_PORT,
                             "--user-data-dir=" + profile,
                             "--window-size=1600,900", URL],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    target = None
    for _ in range(40):
        time.sleep(0.5)
        try:
            data = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % CDP_PORT, timeout=2))
        except Exception:
            continue
        for t in data:
            if t.get("type") == "page" and str(t.get("url", "")).startswith(URL):
                target = t
                break
        if target:
            break
    if not target:
        raise SystemExit("no target")

    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=40)
    cdp(ws, 1, "Page.enable")
    time.sleep(6)

    for page in range(1, PAGES + 1):
        for v in VARIANTS:
            ok = click_text(ws, 1000 + page * 10, v)
            time.sleep(1.1)
            shot = cdp(ws, 2000 + page * 10, "Page.captureScreenshot", {"format": "png"})
            raw = base64.b64decode(shot["result"]["data"])
            name = "page%02d_%s.png" % (page, v.replace("AI", "ai"))
            open(os.path.join(OUT, name), "wb").write(raw)
            print(name, ok, len(raw))
        click_text(ws, 3000 + page, "深色")
        time.sleep(0.8)
        shot = cdp(ws, 3500 + page, "Page.captureScreenshot", {"format": "png"})
        raw = base64.b64decode(shot["result"]["data"])
        open(os.path.join(OUT, "page%02d_dark.png" % page), "wb").write(raw)
        print("page%02d_dark" % page, len(raw))
        for kind in ("keyDown", "keyUp"):
            cdp(ws, 4000 + page, "Input.dispatchKeyEvent",
                {"type": kind, "key": "ArrowRight", "code": "ArrowRight",
                 "windowsVirtualKeyCode": 39, "nativeVirtualKeyCode": 39})
        time.sleep(1.0)

    ws.close()
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
