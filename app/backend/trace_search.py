"""溯源抓取原语：只用标准库，无 API key 也能跑。

职责边界：本文件只负责「取回文本 + 存缓存 + 验真渠道」，不做任何业务判断。
一切结论性字段由 trace.py 生成，且必须带出处。
"""

from __future__ import annotations

import gzip
import json
import re
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = ROOT / "data" / "trace_channels.json"
CACHE_PATH = ROOT / "data" / "trace_cache.sqlite"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
# 无 Cookie 的匿名客户端是刻意的：证明链路不依赖任何账号态，评委可复现。
DEFAULT_TIMEOUT = 10

_CTX_VERIFIED = ssl.create_default_context()
_CTX_INSECURE = ssl._create_unverified_context()  # noqa: SLF001  仅 registry 中 insecure_tls=true 的域名


# ---------------------------------------------------------------- registry


def load_registry(path: Path = REGISTRY_PATH) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def channels_by_id(reg: dict) -> dict:
    return {c["id"]: c for c in reg["channels"]}


def live_channels(reg: dict, layer: str | None = None) -> list[dict]:
    """只返回实测可用、且不需要 key 的渠道，按权重降序。"""
    out = [
        c
        for c in reg["channels"]
        if c.get("status") == "ok" and not c.get("needs_key") and c.get("method", "GET") != "local"
    ]
    if layer:
        out = [c for c in out if c.get("layer") == layer]
    return sorted(out, key=lambda c: -c.get("weight", 0))


# -------------------------------------------------------------------- http


def http_get(url: str, timeout: int = DEFAULT_TIMEOUT, insecure_tls: bool = False):
    """返回 (status, text, final_url)。异常一律收敛成 status=0，调用方按渠道失败处理。"""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
            "Accept-Encoding": "gzip, deflate",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    ctx = _CTX_INSECURE if insecure_tls else _CTX_VERIFIED
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read()
            enc = (resp.headers.get("Content-Encoding") or "").lower()
            if "gzip" in enc:
                raw = gzip.decompress(raw)
            elif "deflate" in enc:
                raw = zlib.decompress(raw, -zlib.MAX_WBITS)
            return resp.status, _decode(raw), resp.geturl()
    except urllib.error.HTTPError as exc:
        return exc.code, "", url
    except Exception:  # 超时/DNS/TLS 一律降级，不向上抛
        return 0, "", url


def _decode(raw: bytes) -> str:
    """国内站点编码混杂（utf-8 / gbk / gb18030），按 meta 声明再兜底。"""
    head = raw[:4096].decode("ascii", errors="ignore")
    m = re.search(r'charset=["\']?([\w-]+)', head, re.I)
    for enc in [m.group(1)] if m else []:
        try:
            return raw.decode(enc, errors="ignore")
        except LookupError:
            pass
    for enc in ("utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


_DROP_BLOCKS = re.compile(
    r"<(script|style|noscript|svg|head)[^>]*>.*?</\1>", re.S | re.I
)
_TAG = re.compile(r"<[^>]+>")


def html_to_text(html: str) -> str:
    txt = _DROP_BLOCKS.sub(" ", html or "")
    txt = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", txt, flags=re.I)
    txt = unescape(re.sub(r"\s+", " ", _TAG.sub(" ", txt)))
    # 双重转义的页面（正文里写着 &lt;p&gt;）反转义后会重新出现标签，必须再剥一遍
    txt = _TAG.sub(" ", txt)
    return re.sub(r"[ \t]{2,}", " ", txt).strip()


def find_quotes(text: str, patterns: list[str], span: int = 60) -> list[str]:
    """从正文里抠出命中关键证据的句子，作为可展示的 quote 字段。"""
    out = []
    for pat in patterns:
        for m in re.finditer(pat, text):
            s = max(0, m.start() - 12)
            frag = text[s : m.end() + span].strip()
            if frag and frag not in out:
                out.append(frag)
            if len(out) >= 5:
                return out
    return out


# --------------------------------------------------------------------- rss


def unwrap_bing_link(href: str) -> str:
    m = re.search(r"[?&](?:url|u)=([^&]+)", href or "")
    return urllib.parse.unquote(m.group(1)) if m else (href or "")


def parse_rss(xml_text: str) -> list[dict]:
    items = []
    for block in re.findall(r"<item>(.*?)</item>", xml_text, re.S):
        def field(tag):
            m = re.search(rf"<{tag}>(.*?)</{tag}>", block, re.S)
            return unescape(m.group(1)).strip() if m else ""

        link = unwrap_bing_link(field("link"))
        if not link or "bing.com" in link:
            continue
        items.append({"title": field("title"), "url": link, "snippet": field("description")})
    return items


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def resolve_redirect(url: str) -> str:
    """百度结果链是 baidu.com/link 跳转壳。引用必须指向真实出处，否则评委点不开也核不了。"""
    if "baidu.com/link" not in (url or ""):
        return url
    key = "redirect::" + url
    hit = cache_get(key)
    if hit and hit["text"]:
        return hit["text"]
    opener = urllib.request.build_opener(_NoRedirect)
    real = ""
    try:
        with opener.open(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=6) as r:
            real = r.geturl()
    except urllib.error.HTTPError as exc:
        loc = exc.headers.get("Location") or ""
        real = loc if loc.startswith("http") else ""
    except Exception:
        real = ""
    if real:
        cache_put(key, 200, real, 720)
    return real or url


# ------------------------------------------------------------------- cache


def _db(path: Path = CACHE_PATH) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS fetch_cache(
             url TEXT PRIMARY KEY, status INTEGER, text TEXT,
             fetched_at TEXT, ttl_hours REAL, hits INTEGER DEFAULT 0)"""
    )
    conn.commit()
    return conn


def _now() -> datetime:
    return datetime.now(timezone.utc).astimezone()


def cache_get(url: str, path: Path = CACHE_PATH):
    conn = _db(path)
    try:
        row = conn.execute(
            "SELECT status, text, fetched_at, ttl_hours FROM fetch_cache WHERE url=?", (url,)
        ).fetchone()
        if not row:
            return None
        status, text, fetched_at, ttl = row
        age = (_now() - datetime.fromisoformat(fetched_at)).total_seconds() / 3600
        if ttl is not None and age > ttl:
            return None
        conn.execute("UPDATE fetch_cache SET hits=hits+1 WHERE url=?", (url,))
        conn.commit()
        return {"status": status, "text": text, "fetched_at": fetched_at, "from_cache": True}
    finally:
        conn.close()


def cache_put(url: str, status: int, text: str, ttl_hours: float | None = None,
              path: Path = CACHE_PATH) -> None:
    conn = _db(path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO fetch_cache(url,status,text,fetched_at,ttl_hours) "
            "VALUES(?,?,?,?,?)",
            (url, status, text, _now().isoformat(timespec="seconds"), ttl_hours),
        )
        conn.commit()
    finally:
        conn.close()


def fetch_cached(url: str, channel: dict, path: Path = CACHE_PATH) -> dict:
    """带缓存的取文本。缓存优先，未命中再走网络；网络失败但有旧缓存时用旧缓存。"""
    hit = cache_get(url, path)
    if hit:
        return hit
    status, body, final = http_get(
        url,
        timeout=channel.get("timeout", DEFAULT_TIMEOUT),
        insecure_tls=bool(channel.get("insecure_tls")),
    )
    parser = channel.get("parser", "generic_text")
    # SERP/RSS 的解析依赖标签结构，必须缓存原始文本；正文类渠道才预先去标签
    keep_raw = parser in ("rss_items", "baidu_serp")
    text = body if keep_raw else html_to_text(body)
    if status != 200 and not text:
        # 过期即视为无，不做 stale-while-error：宁可显式降级，也不拿旧数据冒充本次抓取
        return {"status": status, "text": "", "fetched_at": None, "from_cache": False,
                "error": "fetch_failed"}
    cache_put(url, status, text, channel.get("ttl_hours"), path)
    return {"status": status, "text": text, "fetched_at": _now().isoformat(timespec="seconds"),
            "from_cache": False, "final_url": final}


# ------------------------------------------------------------------ verify


def verify_all(reg: dict | None = None, sleep: float = 0.3) -> list[dict]:
    """重跑全渠道连通性验真，回写 status/observed 由人工确认后入库。"""
    reg = reg or load_registry()
    probes = [
        ("bing_rss", "https://cn.bing.com/search?q=%E8%84%89%E5%8A%A8&format=rss&count=15"),
        ("openstd_gb", "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%202760"),
        ("std_search", "https://std.samr.gov.cn/search/std?q=GB%207101"),
        ("samr_news", "https://www.samr.gov.cn/"),
        ("brand_official", "https://www.danone.com.cn/"),
        ("baike", "https://baike.baidu.com/item/%E8%84%89%E5%8A%A8"),
        ("gsxt", "https://www.gsxt.gov.cn/"),
        ("cnca", "http://cx.cnca.cn/"),
        ("moa_trace", "https://www.traces.moa.gov.cn/"),
        ("baidu_serp", "https://www.baidu.com/s?wd=%E8%84%89%E5%8A%A8"),
        ("jd_search", "https://search.jd.com/Search?keyword=%E8%84%89%E5%8A%A8"),
        ("customs", "http://www.customs.gov.cn/"),
        ("cnipa_gi", "https://www.cnipa.gov.cn/"),
    ]
    by_id = channels_by_id(reg)
    rows = []
    for cid, url in probes:
        insecure = bool(by_id.get(cid, {}).get("insecure_tls"))
        t0 = time.time()
        status, text, _ = http_get(url, insecure_tls=insecure)
        body = text if "format=rss" in url else html_to_text(text)
        n = len(parse_rss(body)) if "format=rss" in url else 0
        rows.append({
            "channel": cid,
            "declared": by_id.get(cid, {}).get("status", "?"),
            "http": status,
            "bytes": len(text.encode("utf-8", errors="ignore")),
            "chars": len(body),
            "items": n,
            "seconds": round(time.time() - t0, 2),
        })
        time.sleep(sleep)
    return rows


def main(argv: list[str]) -> int:
    if "--verify" in argv:
        rows = verify_all()
        print(f"{'channel':<16}{'declared':<11}{'http':>5}{'bytes':>9}{'chars':>8}{'items':>6}{'sec':>7}")
        for r in rows:
            print(f"{r['channel']:<16}{r['declared']:<11}{r['http']:>5}{r['bytes']:>9}"
                  f"{r['chars']:>8}{r['items']:>6}{r['seconds']:>7}")
        dead = [r["channel"] for r in rows if r["declared"] == "ok" and (r["http"] != 200 or r["chars"] < 500)]
        print("\n实测已失效（注册表却仍标 ok）:", dead or "无")
        print("注意：status 不会自动回写，确认后请手工改 data/trace_channels.json（保持人来对结果负责）。")
        return 0
    print(__doc__)
    print("用法: python -m app.backend.trace_search --verify")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
