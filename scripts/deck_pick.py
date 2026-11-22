"""按指定的方案组合设置 Dashi 预览页（每页选 1/2/3/AI + 深色），并截图确认。

用法：python scripts/deck_pick.py <preview-url> <out-dir> <spec>
spec 形如 "ai,1,1,ai,ai,1,1,1,3,ai"（10 页，逗号分隔）
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
SPEC = [x.strip().lower() for x in (sys.argv[3] if len(sys.argv) > 3 else "").split(",") if x.strip()]
CDP_PORT = 9488

RECT_JS = """(() => {
  const group = Array.from(document.querySelectorAll('[role=group]'))
     .find(g => /版式|配色/.test(g.getAttribute('aria-label') || ''));
  const scope = group ? group : document;
  const b = Array.from(scope.querySelectorAll('button')).find(x => (x.textContent||'').trim() === %s);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return {x: r.x + r.width/2, y: r.y + r.height/2, active: b.className.includes('is-active')};
})()"""


def cdp(ws, mid, method, params=None):
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == mid:
            return r


def click_text(ws, mid, label):
    r = cdp(ws, mid, "Runtime.evaluate", {"expression": RECT_JS % json.dumps(label), "returnByValue": True})
    pt = r.get("result", {}).get("result", {}).get("value")
    if not pt:
        return "missing"
    if pt.get("active") and label == "深色":
        return "already"
    for kind in ("mousePressed", "mouseReleased"):
        cdp(ws, mid + 700, "Input.dispatchMouseEvent",
            {"type": kind, "x": pt["x"], "y": pt["y"], "button": "left", "clickCount": 1})
    return "clicked"


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="edge-pick-")
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

    for i, want in enumerate(SPEC, start=1):
        label = "AI" if want in ("ai", "4") else want
        a = click_text(ws, 100 + i, label)
        time.sleep(1.2)
        b = click_text(ws, 200 + i, "深色")
        time.sleep(1.0)
        shot = cdp(ws, 300 + i, "Page.captureScreenshot", {"format": "png"})
        raw = base64.b64decode(shot["result"]["data"])
        open(os.path.join(OUT, "final-%02d.png" % i), "wb").write(raw)
        print("page%02d variant=%s(%s) dark=%s %d" % (i, label, a, b, len(raw)))
        for kind in ("keyDown", "keyUp"):
            cdp(ws, 400 + i, "Input.dispatchKeyEvent",
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
