"""核查项目里每个文件的修改时间是否都落在官方赛期窗口内。

背景
----
AgriHackathon 官方赛程：2026-11-20 18:00 开赛 → 2026-11-22 18:00 截止。
本脚本扫描仓库，输出逐文件清单（CSV）与结论摘要，方便自查、也方便评委核对。

用法
----
    python scripts/file_timeline_check.py                    # 打印摘要 + 写 docs/文件时间清单.csv
    python scripts/file_timeline_check.py --no-write         # 只看摘要
    python scripts/file_timeline_check.py --root <路径>

口径
----
- 同时看两个时间，两个都必须落在赛期内：
  - **创建时间（ctime）**＝这个文件在本机被创建的时间，用来证明「文件是赛期内新做的」；
  - **修改时间（mtime）**＝内容最后写入的时间；文件从别处复制进来时会继承来源的时间，
    因此单独看 mtime 可能骗人，必须和 ctime 一起看。
- 默认排除 `.git/`、`__pycache__/`、`.pytest_cache/`、`*.pyc`（版本库与可再生成的缓存）。
- 判定标准：ctime >= CUTOFF 且 mtime >= CUTOFF 才算「赛期内产出」，否则退出码为 1。
- 注意：zip 只记录 mtime，不记录 ctime；所以提交包里的时间戳以 mtime 为准，两者本文都查。
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from datetime import datetime
from pathlib import Path

CUTOFF = datetime(2026, 11, 20, 18, 0, 0)  # 官方开赛时间

SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", ".idea", ".vscode"}
SKIP_SUFFIX = {".pyc", ".pyo"}

# 本地私有文件：不进提交、不算交付物（本地 Key 配置）
SKIP_FILES = {"scripts/env.local"}

# 运行时缓存：不算交付物，可再生成
RUNTIME_CACHE = {"data/trace_cache.sqlite"}


def walk(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if Path(name).suffix in SKIP_SUFFIX:
                continue
            p = Path(dirpath) / name
            if p.relative_to(root).as_posix() in SKIP_FILES:
                continue
            yield p


def fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=None, help="项目根目录（默认本脚本上一级）")
    ap.add_argument("--no-write", action="store_true", help="不写 CSV")
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    out = root / "docs" / "文件时间清单.csv"

    rows = []
    for p in walk(root):
        st = p.stat()
        mtime = datetime.fromtimestamp(st.st_mtime)
        ctime = datetime.fromtimestamp(st.st_ctime)  # Windows：创建时间
        rel = p.relative_to(root).as_posix()
        rows.append(
            {
                "路径": rel,
                "大小KB": round(st.st_size / 1024, 1),
                "修改时间": fmt(mtime),
                "创建时间": fmt(ctime),
                "修改在赛期内": "是" if mtime >= CUTOFF else "否",
                "创建在赛期内": "是" if ctime >= CUTOFF else "否",
                "运行时缓存": "是" if rel in RUNTIME_CACHE else "",
            }
        )

    total = len(rows)
    bad_m = [r for r in rows if r["修改在赛期内"] == "否"]
    bad_c = [r for r in rows if r["创建在赛期内"] == "否"]
    bad = [r for r in rows if r in bad_m or r in bad_c]
    first_c = min(rows, key=lambda r: r["创建时间"]) if rows else None
    first_m = min(rows, key=lambda r: r["修改时间"]) if rows else None

    print(f"扫描根目录：{root}")
    print(f"截止时间：{fmt(CUTOFF)}（赛期开始）")
    print(f"文件总数：{total}（已排除 .git / __pycache__ / .pytest_cache / *.pyc）")
    if first_c:
        print(f"最早创建：{first_c['创建时间']}  {first_c['路径']}")
    if first_m:
        print(f"最早修改：{first_m['修改时间']}  {first_m['路径']}")
    print(f"创建时间 >= 截止：{total - len(bad_c)} / {total}")
    print(f"修改时间 >= 截止：{total - len(bad_m)} / {total}")

    if bad:
        print("\n早于赛期（创建或修改）的文件：")
        for r in sorted(bad, key=lambda x: x["创建时间"]):
            print(f"  创建 {r['创建时间']} / 修改 {r['修改时间']}  {r['路径']}")

    cache = [r for r in rows if r["运行时缓存"]]
    if cache:
        print("\n运行时缓存（不参与提交）：")
        for r in cache:
            print(f"  {r['修改时间']}  {r['路径']}")

    if not args.no_write:
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(
                fh,
                fieldnames=["路径", "大小KB", "修改时间", "创建时间", "修改在赛期内", "创建在赛期内", "运行时缓存"],
            )
            w.writeheader()
            w.writerows(rows)
        print(f"\n已写入 {out.relative_to(root)}（{total} 行）")

    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
