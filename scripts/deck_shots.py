"""给 Dashi 预览页逐页截图，拼成对照表，用来做成果验收。

用法：python scripts/deck_shots.py <preview-url> <out-dir> <pages> [port]
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
PAGES = int(sys.argv[3]) if len(sys.argv) > 3 else 8
CDP_PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 9333


def cdp(ws, mid, method, params=None, timeout=30):
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="edge-deck-")
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
            if t.get("type") == "page" and str(t.get("url", "")).startswith(URL.split("?")[0]):
                target = t
                break
        if target:
            break
    if not target:
        raise SystemExit("no page target")

    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=40)
    cdp(ws, 1, "Page.enable")
    time.sleep(6)

    # 切到演示模式，截图里不要编辑器面板
    play = """(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .filter(el => (el.textContent || '').trim() === '播放');
      if (!b.length) return 'no-play';
      b[0].click();
      return 'playing';
    })()"""
    r = cdp(ws, 2, "Runtime.evaluate", {"expression": play, "returnByValue": True})
    print("presentation:", r.get("result", {}).get("result", {}).get("value"))
    time.sleep(2.5)

    for i in range(PAGES):
        shot = cdp(ws, 100 + i, "Page.captureScreenshot", {"format": "png"})
        raw = base64.b64decode(shot["result"]["data"])
        p = os.path.join(OUT, "slide-%02d.png" % (i + 1))
        open(p, "wb").write(raw)
        print("shot", p, len(raw))
        for kind in ("keyDown", "keyUp"):
            cdp(ws, 300 + i, "Input.dispatchKeyEvent", {
                "type": kind, "key": "ArrowRight", "code": "ArrowRight",
                "windowsVirtualKeyCode": 39, "nativeVirtualKeyCode": 39,
            })
        time.sleep(0.9)

    ws.close()
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
