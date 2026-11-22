"""抓取中国食品品牌/品类，补充 data/openfoodfacts_cn.json。

数据源：OpenFoodFacts（ODbL），与现有商品库同源。
策略：按品牌搜索 → 保留"品牌明确 + 名称可用"的商品 → 与现有库按条码去重 → 追加。
限流：每次请求间隔 1.5s，503 退避重试，避免被 OpenFoodFacts 封禁。

用法（预览，不写文件）：
    python scripts/fetch_brands.py --preview
用法（写回数据库）：
    python scripts/fetch_brands.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "openfoodfacts_cn.json"

# 队友点名"好丽友面包" + 常见中国食品品牌
BRANDS = [
    "好丽友", "达利园", "可比克", "盼盼", "旺旺", "徐福记",
    "三只松鼠", "良品铺子", "康师傅", "统一", "伊利", "蒙牛",
    "光明", "君乐宝", "娃哈哈", "农夫山泉", "元气森林", "百事",
    "乐事", "奥利奥", "雀巢", "双汇", "金锣", "湾仔码头",
]

FIELDS = "code,product_name,product_name_zh,brands,ingredients_text,categories,quantity,image_front_url,nutriments"
HEADERS = {"User-Agent": "DeepEggy/1.0 (food-data-research; contact: team)"}
SLEEP = 1.5
MAX_RETRY = 3


def fetch_brand(brand: str, page_size: int = 50) -> list[dict]:
    """抓一个品牌，带 503 退避重试。"""
    q = urllib.parse.urlencode({
        "search_terms": brand, "search_simple": 1, "action": "process",
        "json": 1, "page_size": page_size, "fields": FIELDS, "lang": "zh",
    })
    url = "https://world.openfoodfacts.org/cgi/search.pl?" + q
    for attempt in range(MAX_RETRY):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=40) as r:
                data = json.load(r)
            return data.get("products") or []
        except urllib.error.HTTPError as e:
            if e.code == 503 and attempt < MAX_RETRY - 1:
                time.sleep(3 * (attempt + 1))
                continue
            print(f"  [{brand}] HTTP {e.code}，跳过")
            return []
        except Exception as e:
            print(f"  [{brand}] {type(e).__name__}: {str(e)[:60]}，跳过")
            return []
    return []


def has_chinese(s: str) -> bool:
    return any("\u4e00" <= c <= "\u9fff" for c in (s or ""))


def to_entry(p: dict, brand_query: str) -> dict | None:
    """把一个 OFF 商品转成现有库结构；不合格返回 None。"""
    code = str(p.get("code") or "").strip()
    if not code.isdigit():
        return None
    name = (p.get("product_name_zh") or p.get("product_name") or "").strip()
    brands = (p.get("brands") or "").strip()
    # 必须有中文名或明确品牌，否则对中文用户无用
    if not name and not brands:
        return None
    # 品牌字段里要真的包含查询的品牌（剔除搜索误命中）
    if brand_query not in brands and brand_query not in name and not has_chinese(name):
        return None
    # 名称明显是非中文小语种（越南语/俄语等）且无配料表 → 对中文用户无展示价值，跳过
    if name and not has_chinese(name) and not (p.get("ingredients_text") or "").strip():
        if not re.search(r"[a-zA-Z]{3}", name):  # 纯英文/拼音名保留
            return None

    nutrition = {}
    nutr = p.get("nutriments") or {}
    for src, dst in [
        ("energy-kcal_100g", "energy_kcal_100g"),
        ("proteins_100g", "proteins_100g"),
        ("fat_100g", "fat_100g"),
        ("carbohydrates_100g", "carbohydrates_100g"),
        ("sodium_100g", "sodium_100g"),
        ("sugars_100g", "sugars_100g"),
    ]:
        v = nutr.get(src)
        if isinstance(v, (int, float)):
            nutrition[dst] = v

    return {
        "code": code,
        "name": name[:120],
        "brand": brands[:120],
        "ingredients": (p.get("ingredients_text") or "").strip()[:2000],
        "categories": (p.get("categories") or "").strip()[:160],
        "image": (p.get("image_front_url") or "").strip(),
        "nutrition": nutrition,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true", help="只预览，不写文件")
    ap.add_argument("--apply", action="store_true", help="写回数据库")
    args = ap.parse_args()
    if not args.preview and not args.apply:
        ap.error("请指定 --preview 或 --apply")

    db = json.loads(DB.read_text(encoding="utf-8"))
    existing = db.get("products") or []
    seen = {str(p.get("code")) for p in existing}
    print(f"现有商品 {len(existing)} 条，去重条码 {len(seen)} 个")

    fresh = []
    for i, brand in enumerate(BRANDS, 1):
        print(f"[{i}/{len(BRANDS)}] 抓取 {brand} ...")
        raw = fetch_brand(brand)
        added = 0
        for p in raw:
            e = to_entry(p, brand)
            if e and e["code"] not in seen:
                seen.add(e["code"])
                fresh.append(e)
                added += 1
        print(f"  抓到 {len(raw)} 条，新增 {added} 条")
        time.sleep(SLEEP)

    with_ing = sum(1 for p in fresh if p["ingredients"])
    print(f"\n合计新增 {len(fresh)} 条，其中有配料表 {with_ing} 条")

    if args.preview:
        print("\n=== 前 15 条预览 ===")
        for p in fresh[:15]:
            print(f"  {p['code']} | {p['name'][:32]:<32} | {p['brand'][:20]:<20} | 配料{len(p['ingredients'])}字")
        print("\n（预览模式，未写文件）")
        return

    # 先备份原库字节内容，再修改
    original = DB.read_bytes()
    db["products"] = existing + fresh
    db["count"] = len(db["products"])
    db["source"] = "OpenFoodFacts (ODbL) + 品牌补充抓取 2026-11-22"
    backup = DB.with_name(DB.name + ".bak")
    backup.write_bytes(original)
    DB.write_text(json.dumps(db, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n原库已备份至 {backup}")
    print(f"已写回 {DB}，总数 {db['count']}")


if __name__ == "__main__":
    main()
