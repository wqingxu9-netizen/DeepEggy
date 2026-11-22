"""把 Dashi 预览页逐页切到深色配色，并（可选）截取演示模式下的每页。

用法：python scripts/deck_dark.py <preview-url> <pages>
"""
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
URL = sys.argv[1]
PAGES = int(sys.argv[2]) if len(sys.argv) > 2 else 10
CDP_PORT = 9444

FIND_DARK = """(() => {
  const bt = Array.from(document.querySelectorAll('button, [role=button], label, span'))
    .filter(el => (el.textContent || '').trim() === '深色');
  if (!bt.length) return 'no-dark';
  const el = bt[0];
  el.click();
  return 'clicked';
})()"""

NEXT = None


def cdp(ws, mid, method, params=None):
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg


def key(ws, mid, name, code, vk):
    for kind in ("keyDown", "keyUp"):
        cdp(ws, mid, "Input.dispatchKeyEvent",
            {"type": kind, "key": name, "code": code,
             "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})


def main():
    profile = tempfile.mkdtemp(prefix="edge-dark-")
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
        raise SystemExit("no target")

    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=40)
    cdp(ws, 1, "Page.enable")
    time.sleep(6)

    for i in range(PAGES):
        r = cdp(ws, 10 + i, "Runtime.evaluate", {"expression": FIND_DARK, "returnByValue": True})
        print("page", i + 1, "->", r.get("result", {}).get("result", {}).get("value"))
        time.sleep(0.6)
        key(ws, 40 + i, "ArrowRight", "ArrowRight", 39)
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
