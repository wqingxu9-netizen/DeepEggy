"""校验并重建 data/manual/food_lexicon.json（商品名 → GB 2760 食品分类号）。

用途
----
词表是本队人工维护的资产（消费者会写在商品名里的词 → 食品分类号），
`_meta.note` 里约定「新增条目前先用 scripts/build_food_tree.py --path 确认分类号存在」。
本脚本把这条约定自动化，并在每次重建时重写 `_meta`（条数、词数、校验时间）。

校验内容
--------
1. 分类号必须存在于 data/food_tree.sqlite 的 food_categories 表
2. 同一条目内词不能重复；同一个词不能挂在两个分类号上
3. 词不能为空字符串
4. `_meta.count` / `_meta.word_count` 与实际一致

用法
----
    python scripts/validate_food_lexicon.py            # 校验并重写（有错也重写，同时列出问题）
    python scripts/validate_food_lexicon.py --check     # 只校验，不改文件（CI/提交前用）
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEXICON = ROOT / "data" / "manual" / "food_lexicon.json"
FOOD_TREE = ROOT / "data" / "food_tree.sqlite"

# 分类号 → 名称（用于报告里可读）
CODE_RE = None


def load_codes(db_path: Path) -> dict[str, str]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT code, name FROM food_categories").fetchall()
    finally:
        con.close()
    return {code: name for code, name in rows}


def dump_lexicon(data: dict) -> str:
    """按现有风格输出：2 空格缩进，每个条目一行。"""
    head = {
        "_meta": data["_meta"],
    }
    lines = ["{", '  "_meta": {']
    meta = head["_meta"]
    items = list(meta.items())
    for i, (k, v) in enumerate(items):
        tail = "," if i < len(items) - 1 else ""
        lines.append(f'    "{k}": {json.dumps(v, ensure_ascii=False)}{tail}')
    lines.append("  },")
    lines.append('  "entries": [')
    entries = data["entries"]
    for i, e in enumerate(entries):
        tail = "," if i < len(entries) - 1 else ""
        words = json.dumps(e["words"], ensure_ascii=False)
        lines.append(f'    {{"words": {words}, "code": {json.dumps(e["code"])}}}{tail}')
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="只校验，不写文件")
    args = ap.parse_args()

    for p in (LEXICON, FOOD_TREE):
        if not p.exists():
            print(f"缺少文件：{p}", file=sys.stderr)
            return 2

    data = json.loads(LEXICON.read_text(encoding="utf-8"))
    entries = data.get("entries") or []
    codes = load_codes(FOOD_TREE)

    problems: list[str] = []
    seen_word: dict[str, str] = {}
    total_words = 0

    for idx, e in enumerate(entries, 1):
        code = e.get("code", "")
        words = e.get("words") or []
        if code not in codes:
            problems.append(f"第 {idx} 条：分类号 {code!r} 不在 food_tree.sqlite 里")
        if not words:
            problems.append(f"第 {idx} 条（{code}）：words 为空")
        local = set()
        for w in words:
            if not str(w).strip():
                problems.append(f"第 {idx} 条（{code}）：出现空的词")
                continue
            if w in local:
                problems.append(f"第 {idx} 条（{code}）：词 {w!r} 在同一条目里重复")
            local.add(w)
            prev = seen_word.get(w)
            if prev and prev != code:
                problems.append(f"词 {w!r} 同时挂在 {prev} 和 {code}")
            seen_word.setdefault(w, code)
        total_words += len(words)

    dup_codes = [c for c in {e.get("code") for e in entries} if
                 sum(1 for e in entries if e.get("code") == c) > 1]

    meta = dict(data.get("_meta") or {})
    old_count, old_words = meta.get("count"), meta.get("word_count")
    meta["count"] = len(entries)
    meta["word_count"] = total_words
    meta["codes"] = len({e.get("code") for e in entries})
    meta["validated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    meta["version"] = datetime.now().strftime("%Y-%m-%d")
    meta["validator"] = "scripts/validate_food_lexicon.py"

    print(f"条目 {len(entries)} 条 / 词 {total_words} 个 / 分类号 {meta['codes']} 个")
    if old_count != meta["count"] or old_words != total_words:
        print(f"  _meta 已同步：count {old_count} -> {meta['count']}，word_count {old_words} -> {total_words}")
    if dup_codes:
        problems.append(f"分类号重复出现：{sorted(dup_codes)}")

    if problems:
        print(f"\n发现 {len(problems)} 个问题：")
        for p in problems:
            print("  -", p)
    else:
        print("  校验通过：分类号全部命中 food_tree，无重复词、无空词")

    if args.check:
        return 1 if problems else 0

    data["_meta"] = meta
    LEXICON.write_text(dump_lexicon(data), encoding="utf-8")
    print(f"\n已写入 {LEXICON.relative_to(ROOT)}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
