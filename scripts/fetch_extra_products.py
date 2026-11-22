"""批量抓取中文零食商品（第三轮）：150+ 商品名 + 5 种搜索策略

用法：python scripts/fetch_extra_products.py
环境变量：TAVILY_API_KEY、DEEPSEEK_API_KEY
"""
import json
import os
import sys
import time

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)
sys.path.insert(0, os.path.join(PROJECT_ROOT, "app", "backend"))

from app.backend import barcode_lookup as bl  # noqa: E402
from app.backend import analyze as analyze_mod  # noqa: E402

OUT = os.path.join(PROJECT_ROOT, "data", "extra_products.json")

# 商品名（150+，覆盖没抓到的 + 新场景）
QUERIES = [
    # 辣条/豆干/魔芋
    "卫龙大面筋", "卫龙魔芋爽", "卫龙亲嘴豆皮", "卫龙小面筋", "卫龙辣条大礼包",
    "良品铺子面筋", "盐津铺子鱼豆腐", "三只松鼠辣条", "口水娃辣条", "贤妻辣条",
    "卫龙大辣片", "麻辣王子微麻微辣", "君仔辣条", "馋嘴猴辣条",
    # 薯片/膨化
    "乐事原味薯片", "乐事黄瓜味薯片", "乐事青柠味薯片", "可比克原味薯片",
    "可比克番茄味薯片", "上好佳洋葱圈", "上好佳荷兰豆", "上好佳薯条",
    "盼盼薯片", "达利园薯片", "咪咪虾条", "亲亲虾条", "旺旺仙贝", "旺旺雪饼",
    "旺仔小馒头", "浪味仙", "奇多", "多力多滋", "品客薯片", "好丽友薯愿",
    # 面包/糕点
    "达利园蛋黄派", "达利园法式软面包", "达利园瑞士卷", "好丽友派",
    "盼盼法式小面包", "桃李面包", "三只松鼠手撕面包", "徐福记沙琪玛",
    "港荣蒸蛋糕", "卡尔顿面包", "豪士面包", "友臣肉松饼", "小白心里软",
    # 饼干
    "奥利奥原味饼干", "趣多多曲奇", "康师傅3+2饼干", "好吃点饼干",
    "闲趣饼干", "太平梳打饼干", "嘉士利饼干", "苏打饼干", "旺旺黑白配",
    # 糖果/巧克力
    "大白兔奶糖", "阿尔卑斯棒棒糖", "旺仔牛奶糖", "金丝猴奶糖", "雅客软糖",
    "徐福记酥心糖", "彩虹糖", "曼妥思", "荷氏薄荷糖", "德芙牛奶巧克力",
    "士力架", "费列罗巧克力", "好时巧克力", "m豆巧克力", "瑞士莲巧克力",
    # 果冻/蜜饯
    "喜之郎果冻", "蜡笔小新果冻", "旺旺碎冰冰", "溜溜梅", "三只松鼠芒果干",
    "良品铺子话梅", "来伊份蜜饯", "华味亨蜜饯",
    # 坚果
    "三只松鼠每日坚果", "良品铺子每日坚果", "洽洽香瓜子", "百草味夏威夷果",
    "沃隆每日坚果", "来伊份开心果", "三只松鼠碧根果", "巴旦木", "开心果",
    # 肉脯/肉干
    "良品铺子猪肉脯", "三只松鼠牛肉干", "周黑鸭鸭脖", "绝味鸭脖", "来伊份肉松",
    "五芳斋", "双汇火腿肠",
    # 饮料
    "康师傅冰红茶", "农夫山泉茶π", "农夫山泉东方树叶", "元气森林白桃气泡水",
    "脉动水蜜桃", "尖叫饮料", "红牛维生素饮料", "王老吉凉茶", "加多宝凉茶",
    "娃哈哈AD钙奶", "养乐多", "蒙牛纯甄酸奶", "伊利安慕希", "光明莫斯利安",
    "香飘飘奶茶", "优乐美奶茶", "阿萨姆奶茶", "佳得乐", "宝矿力水特",
    "维他柠檬茶", "东鹏特饮", "怡宝", "冰露",
    # 方便食品
    "康师傅红烧牛肉面", "统一老坛酸菜面", "白象汤好喝", "今麦郎一桶半",
    "汤达人日式豚骨面", "合味道海鲜面", "拉面说", "五谷道场",
    # 其他
    "卫龙亲嘴烧", "旺仔牛奶", "喜之郎CiCi果冻爽", "三只松鼠坚果",
    "来伊份薯片", "卫龙软豆皮",
]

EXTRACT_PROMPT = """你是数据提取员。给你一段中文网页内容（零食商品介绍/测评/电商页），请提取其中**明确列了配料**的中国零食商品。

输出严格 JSON 数组，最多 3 个商品：
[{"name": "商品名（如：卫龙大面筋）", "brand": "品牌（如：卫龙）", "category": "品类（如：辣条）", "ingredients": "配料内容（原文，用顿号连接）"}]

规则：
1. 只提取**确实出现**的商品，不要编造。
2. ingredients 是网页里明确列出的配料/成分内容（可以是「配料：」「配料表：」「成分：」开头，或商品详情页的配料列表）；**没有明确配料列表的商品不要提取**。
3. 成分保持原文，不要翻译、不要改写、不要补全。
4. 没有符合条件的商品就返回空数组 []。
5. 只输出 JSON，不要其他文字。"""


def extract_products(query: str, results: list) -> list:
    lines = []
    for i, r in enumerate(results[:6], 1):
        lines.append(f"[{i}] 标题：{r.get('title', '')}")
        lines.append(f"    内容：{(r.get('snippet') or '')[:1200]}")
    user = f"搜索词：{query}\n\n网页内容：\n" + "\n".join(lines)
    try:
        raw = analyze_mod._call_llm(EXTRACT_PROMPT, user)
        data = analyze_mod._parse_json(raw)
        if isinstance(data, dict):
            data = data.get("products") or data.get("items") or []
        return data if isinstance(data, list) else []
    except Exception as exc:
        print(f"  AI 提取失败: {exc}", flush=True)
        return []


def main():
    if not os.getenv("TAVILY_API_KEY") or not os.getenv("DEEPSEEK_API_KEY"):
        print("缺少 TAVILY_API_KEY 或 DEEPSEEK_API_KEY")
        return 1

    products = []
    seen = set()
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
            products = old.get("products") or []
            seen = {p.get("name", "") for p in products}
            print(f"已有 {len(products)} 条，继续追加", flush=True)
        except Exception:
            pass

    # 3 轮搜索策略（成功即停；150 商品 × 最多 3 次搜索 = 450 次，控制 Tavily 额度）
    strategies = [
        "配料表",
        "配料 成分",
        "营养成分表 配料",
    ]

    for q in QUERIES:
        print(f"\n=== [{q}]", flush=True)
        hit = False
        for suffix in strategies:
            query = q + " " + suffix
            results = bl.search_web(query, count=6)
            if not results:
                time.sleep(1)
                continue
            prods = extract_products(q, results)
            added = 0
            for p in prods:
                if not isinstance(p, dict):
                    continue
                name = str(p.get("name") or "").strip()
                ing = str(p.get("ingredients") or "").strip()
                brand = str(p.get("brand") or "").strip()
                cat = str(p.get("category") or "").strip()
                if not name or len(ing) < 8 or name in seen:
                    continue
                seen.add(name)
                products.append({
                    "name": name[:40], "brand": brand[:20], "category": cat[:12],
                    "ingredients": ing[:400], "source": "tavily",
                })
                added += 1
            if added:
                print(f"  [{suffix}] +{added}，累计 {len(products)}", flush=True)
                json.dump({"count": len(products), "products": products},
                          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
                hit = True
                break
            time.sleep(1)
        if not hit:
            print("  （0 条）", flush=True)
        time.sleep(0.5)

    print(f"\n完成！共 {len(products)} 条 → {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
