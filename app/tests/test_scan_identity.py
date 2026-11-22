"""扫码身份一致性测试：确保「扫 A 出 B」不会再从代码或数据上发生。

守三条：
1. 示例数据（mock.js）必须标 demoOnly，且扫码链路不许读示例库；
2. 后端内置条码必须是合法 EAN-13（校验位对），否则根本不该进条码库；
3. 前端「内置商品 → 本地补全」这一步必须同时校验 barcode 与 demoOnly，
   不能只按 id 找（那是 2026-11-22 扫 A 出 B 的根因）。
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONT = ROOT / "app" / "frontend"
BACK = ROOT / "app" / "backend" / "main.py"


def _ean_ok(code: str) -> bool:
    """EAN-13 校验位：从右往左，倒数第二位起 3、1、3、1 交替加权。"""
    if not re.fullmatch(r"\d{13}", code):
        return False
    total = sum(int(c) * (3 if i % 2 == 0 else 1) for i, c in enumerate(code[-2::-1]))
    return (total + int(code[-1])) % 10 == 0


def _builtin_entries():
    """内置条码 → 条目文本（用来判断有没有 demo 标记）。"""
    src = BACK.read_text(encoding="utf-8")
    start = src.index("PRODUCTS = {")
    block = src[start:src.index("\n    }", start)]
    return re.findall(r'"(\d{8,14})"\s*:\s*(\{[^}]*\})', block)


def _builtin_codes():
    return [code for code, _ in _builtin_entries()]


def test_demo_products_are_marked_demo_only():
    mock = (FRONT / "mock.js").read_text(encoding="utf-8")
    assert "demoOnly = true" in mock, "示例数据必须显式标 demoOnly"
    assert re.search(r"LIST\.forEach\(function \(p\) \{ p\.demoOnly = true; \}\)", mock), (
        "demoOnly 要挂在整个示例列表上，避免漏标某一条")


def test_scan_flow_never_reads_demo_library():
    app = (FRONT / "app.js").read_text(encoding="utf-8")
    on_code = app[app.index("function onCodeFound"):]
    on_code = on_code[:on_code.index("function handleScanResult")]
    assert "DEMO.lookup" not in on_code, "扫码链路不许读示例库：扫到的码只能由后端条码库解释"
    assert "/api/scan-barcode" in on_code, "扫码必须走后端条码库"


def test_builtin_remap_checks_barcode_and_demo_flag():
    app = (FRONT / "app.js").read_text(encoding="utf-8")
    seg = app[app.index("function handleScanResult"):]
    seg = seg[:seg.index("function analyzeBarcodeWeb")]
    assert "!x.demoOnly" in seg, "内置商品补全必须排除示例数据"
    assert "x.barcode === code" in seg, "内置商品补全必须校验条码一致，不能只按 id 匹配"


def test_builtin_barcodes_are_valid_unless_demo():
    """真商品条码必须校验位合法；校验位不合法的一律是演示占位，要显式标 demo。"""
    bad = []
    for code, body in _builtin_entries():
        if not _ean_ok(code) and '"demo"' not in body:
            bad.append(code)
    assert not bad, "这些内置条码校验位不合法又没标 demo：%s" % bad


def test_result_card_shows_identity_source():
    app = (FRONT / "app.js").read_text(encoding="utf-8")
    assert "p.__via = via" in app, "结果卡必须记录来源"
    assert "示例数据 · 仅供演示" in app, "示例结果必须在卡片上标明"
    assert "扫码识别" in app and "拍照识别" in app, "扫码与拍照结果必须在卡片上区分"


def test_scan_audit_log_exists():
    src = BACK.read_text(encoding="utf-8")
    assert "_log_scan(" in src and "[scan]" in src, "扫码要有审计日志，出问题能回查"
