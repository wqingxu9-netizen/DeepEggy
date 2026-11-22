"""云 OCR 备选通道：百度 OCR（专用）或智谱 GLM-4V（视觉大模型）

与 ocr.py（本地 PaddleOCR-VL）接口一致：recognize(image_base64) -> {"text", "lowConf", "engine"}

环境变量（任选其一）：
  BAIDU_OCR_IAM_KEY                          → 百度智能云 IAM API Key（bce-v3/ALTAK-... 格式，Bearer 认证）
  BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY   → 百度 OCR 旧版应用 Key（access_token 认证）
  ZHIPU_API_KEY                              → 智谱 GLM-4V（glm-4v-flash 免费额度）
  ZHIPU_MODEL                                → 默认 glm-4v-flash
"""
import json
import os
import time
import urllib.parse
import urllib.request

BAIDU_IAM_KEY = os.getenv("BAIDU_OCR_IAM_KEY", "").strip()
BAIDU_KEY = os.getenv("BAIDU_OCR_API_KEY", "").strip()
BAIDU_SECRET = os.getenv("BAIDU_OCR_SECRET_KEY", "").strip()
ZHIPU_KEY = os.getenv("ZHIPU_API_KEY", "").strip()

_token_cache = {"token": "", "expires": 0.0}


def _parse_baidu_result(data: dict) -> dict:
    if data.get("error_code"):
        code = data.get("error_code")
        msg = data.get("error_msg") or ""
        # 把百度错误码翻译成人话
        if code == 216630:
            raise RuntimeError("图片里没认到清晰文字，请靠近一点、对准光线再拍一张")
        if code == 216201:
            raise RuntimeError("图片格式不对，请用相机拍照后重试")
        if code in (17, 18):
            raise RuntimeError("OCR 服务额度或权限不足，请联系管理员")
        if code == 14:
            raise RuntimeError("OCR 认证失败，请联系管理员")
        raise RuntimeError(f"百度 OCR 错误 {code}: {msg}")
    words = [w.get("words", "") for w in data.get("words_result") or []]
    text = "\n".join(w for w in words if w).strip()
    if not text:
        raise RuntimeError("百度 OCR 没识别到文字，请换一张更清晰的照片")
    return {"text": text, "lowConf": [], "engine": "Baidu-OCR"}


def _baidu_ocr_iam(image_b64: str) -> dict:
    """新版 IAM Key：Authorization: Bearer bce-v3/ALTAK-..."""
    body = urllib.parse.urlencode({"image": image_b64}).encode()
    # 先试高精度版，失败退回标准版
    for endpoint in ("general_accurate", "general_basic"):
        req = urllib.request.Request(
            f"https://aip.baidubce.com/rest/2.0/ocr/v1/{endpoint}",
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": "Bearer " + BAIDU_IAM_KEY,
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("error_code") in (17, 18, 282000, 282003):
            continue  # 高精度版无权限/未开通，试标准版
        result = _parse_baidu_result(data)
        result["engine"] = f"Baidu-OCR-{'accurate' if endpoint.endswith('accurate') else 'basic'}"
        return result
    raise RuntimeError("百度 OCR 高精度版和标准版均不可用")


def _baidu_token() -> str:
    if _token_cache["token"] and time.time() < _token_cache["expires"] - 120:
        return _token_cache["token"]
    url = (
        "https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials"
        f"&client_id={BAIDU_KEY}&client_secret={BAIDU_SECRET}"
    )
    with urllib.request.urlopen(url, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "access_token" not in data:
        raise RuntimeError(f"百度 OCR 获取 token 失败：{data.get('error_description') or data}")
    _token_cache["token"] = data["access_token"]
    _token_cache["expires"] = time.time() + float(data.get("expires_in") or 2592000)
    return _token_cache["token"]


def _baidu_ocr(image_b64: str) -> dict:
    """旧版应用 Key：先换 access_token"""
    body = urllib.parse.urlencode({"image": image_b64}).encode()
    req = urllib.request.Request(
        "https://aip.baidubce.com/rest/2.0/ocr/v1/general_accurate?access_token=" + _baidu_token(),
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return _parse_baidu_result(data)


def _zhipu_ocr(image_b64: str) -> dict:
    payload = {
        "model": os.getenv("ZHIPU_MODEL", "glm-4v-flash"),
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_b64}},
                    {"type": "text", "text": "请把图片里的所有文字完整、原样提取出来，保持原有顺序和换行，只输出文字内容，不要任何解释。"},
                ],
            }
        ],
        "temperature": 0.1,
    }
    req = urllib.request.Request(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + ZHIPU_KEY},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = (data["choices"][0]["message"]["content"] or "").strip()
    if not text:
        raise RuntimeError("智谱 GLM-4V 未识别到文字")
    return {"text": text, "lowConf": [], "engine": "Zhipu-GLM-4V"}


def available() -> bool:
    return bool(BAIDU_IAM_KEY or (BAIDU_KEY and BAIDU_SECRET) or ZHIPU_KEY)


def recognize(image_base64: str) -> dict:
    """云 OCR 识别：百度 IAM Key > 百度旧版应用 Key > 智谱 GLM-4V"""
    if not image_base64 or not str(image_base64).strip():
        raise ValueError("缺少图片数据")
    if BAIDU_IAM_KEY:
        return _baidu_ocr_iam(image_base64)
    if BAIDU_KEY and BAIDU_SECRET:
        return _baidu_ocr(image_base64)
    if ZHIPU_KEY:
        return _zhipu_ocr(image_base64)
    raise RuntimeError("云 OCR 未配置（需要 BAIDU_OCR_IAM_KEY 或 BAIDU_OCR_API_KEY/SECRET 或 ZHIPU_API_KEY）")
