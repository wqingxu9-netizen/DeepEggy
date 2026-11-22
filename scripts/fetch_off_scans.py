"""补 OpenFoodFacts 的众包扫描数 unique_scans_n → data/hotness/off_scans.json

用法：python -m scripts.fetch_off_scans [--limit N]
在服务器上跑（家里网络访问 world.openfoodfacts.org 偏慢）。中断也不怕，每 50 条落盘一次。
"""

import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "openfoodfacts_cn.json"
OUT = ROOT / "data" / "hotness" / "off_scans.json"
API = "https://world.openfoodfacts.org/api/v2/product/%s?fields=unique_scans_n"
UA = "DeepEggy/1.0 (hackathon demo)"
WORKERS = 2
SPACING = 0.55          # 每条之间停一下：OFF 免费接口对并发很敏感（10 线程会被大面积 429）


def _one(code):
    for attempt in range(3):
        try:
            req = urllib.request.Request(API % code, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=12) as r:
                data = json.loads(r.read().decode("utf-8", "ignore"))
            time.sleep(SPACING)
            return code, int((data.get("product") or {}).get("unique_scans_n") or 0)
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return code, None


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    codes = [str(p.get("code") or "").strip() for p in json.loads(DATA.read_text(encoding="utf-8")).get("products") or []]
    codes = [c for c in codes if c]
    if limit:
        codes = codes[:limit]
    try:
        done = json.loads(OUT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        done = {}

    todo = [c for c in codes if c not in done]
    print("总 %d 条，已有 %d 条，待抓 %d 条" % (len(codes), len(done), len(todo)), flush=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    ok = miss = 0
    start = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for i, (code, n) in enumerate(pool.map(_one, todo), 1):
            if n is None:
                miss += 1
            else:
                done[code] = n
                ok += 1
            if i % 100 == 0:
                OUT.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
                print("  %d/%d（成功 %d 失败 %d，%.0fs）" % (i, len(todo), ok, miss, time.time() - start), flush=True)
    OUT.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
    print("完成：成功 %d，失败 %d，累计 %d 条 → %s" % (ok, miss, len(done), OUT), flush=True)


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()
