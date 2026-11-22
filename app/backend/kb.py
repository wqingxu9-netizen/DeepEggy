"""GB 2760 知识库只读层（基于公开国标数据）

数据来源：data/kb.sqlite（添加剂主档 + 使用范围）、data/food_tree.sqlite（食品分类）、
data/manual/food_lexicon.json（商品名 → 分类号词表）
"""
import json
import sqlite3
from pathlib import Path

BASE = Path(__file__).resolve().parent          # app/backend
ROOT = BASE.parent.parent                       # 项目根
DATA = ROOT / "data"

_conns = {}
_lexicon = None
_ingredient_names = None


def _db(name):
    if name not in _conns:
        p = DATA / name
        _conns[name] = sqlite3.connect(str(p), check_same_thread=False) if p.exists() else None
    return _conns[name]


def find_additive(name):
    """按中文名查添加剂（精确优先，其次包含匹配）"""
    conn = _db("kb.sqlite")
    if conn is None or not name:
        return None
    sql = ("SELECT zh, en, cns, ins, function, standard_no, main_desc, components_text, usage_count "
           "FROM additives WHERE zh = ? LIMIT 1")
    row = conn.execute(sql, (name,)).fetchone()
    if row is None:
        row = conn.execute(sql.replace("zh = ?", "zh LIKE ?"), (f"%{name}%",)).fetchone()
    if row is None:
        return None
    return {
        "zh": row[0], "en": row[1], "cns": row[2], "ins": row[3],
        "function": row[4], "standard_no": row[5],
        "main_desc": row[6], "components": row[7], "usage_count": row[8],
    }


def usages(additive_zh, limit=5):
    """某添加剂在哪些食品类别里允许使用、上限多少"""
    conn = _db("kb.sqlite")
    if conn is None or not additive_zh:
        return []
    rows = conn.execute(
        "SELECT food_name, max_use FROM additive_usages WHERE additive_zh = ? LIMIT ?",
        (additive_zh, limit),
    ).fetchall()
    return [{"food": r[0], "max_use": r[1]} for r in rows]


def _lex():
    global _lexicon
    if _lexicon is None:
        p = DATA / "manual" / "food_lexicon.json"
        try:
            _lexicon = json.loads(p.read_text(encoding="utf-8")).get("entries", [])
        except (OSError, ValueError):
            _lexicon = []
    return _lexicon


def classify(text):
    """商品名/文本 → GB 2760 食品类别号（词表包含匹配，最长词优先）"""
    if not text:
        return None
    best = None
    for ent in _lex():
        for w in ent.get("words", []):
            if w and w in text and (best is None or len(w) > best[0]):
                best = (len(w), ent.get("code"), w)
    if best:
        return {"code": best[1], "matched": best[2]}
    return None


def ingredients_context(ingredients):
    """给提示词用的「权威参考」：配料里哪些是 GB 2760 收录的添加剂，附功能与常见用量"""
    lines = []
    for ing in ingredients or []:
        name = (ing or "").strip()
        if not name or len(name) > 24:
            continue
        add = find_additive(name)
        if not add:
            continue
        line = f"{add['zh']}：CNS {add['cns'] or '—'}，功能「{add['function'] or '—'}」"
        if add.get("main_desc"):
            line += f"；{add['main_desc'][:90]}"
        us = [u for u in usages(add["zh"], 3) if u.get("food")]
        if us:
            line += "；常见允许：" + "、".join(f"{u['food']}（{u['max_use']}）" for u in us)
        lines.append(line)
        if len(lines) >= 8:
            break
    return "\n".join(lines)


def ingredient_names():
    """Return canonical additive names kept in the local GB 2760 database."""
    global _ingredient_names
    if _ingredient_names is None:
        conn = _db("kb.sqlite")
        if conn is None:
            _ingredient_names = []
        else:
            _ingredient_names = [row[0] for row in conn.execute(
                "SELECT DISTINCT zh FROM additives WHERE zh IS NOT NULL AND zh != ''"
            ).fetchall()]
    return _ingredient_names
