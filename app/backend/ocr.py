"""PaddleOCR-VL adapter for the existing POST /api/ocr contract.

The PaddleX model cache is kept inside this project at data/models/paddlex.
User uploads are written to a temporary file and deleted after recognition.
"""
from __future__ import annotations

import base64
import binascii
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODEL_HOME = PROJECT_ROOT / "data" / "models" / "paddlex"
MODEL_HOME.mkdir(parents=True, exist_ok=True)

# Set this before importing PaddleOCR/PaddleX so model downloads stay project-local.
os.environ.setdefault("PADDLEX_HOME", str(MODEL_HOME))
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")

_pipeline: Any = None
_init_lock = threading.Lock()
_inference_lock = threading.Lock()


def _get_pipeline() -> Any:
    global _pipeline
    if _pipeline is None:
        with _init_lock:
            if _pipeline is None:
                from paddleocr import PaddleOCRVL

                # Explicit GPU selection prevents an unnoticed CPU fallback.
                _pipeline = PaddleOCRVL(device="gpu:0")
    return _pipeline


def warmup() -> None:
    """Initialize the pipeline and download its model files if needed."""
    _get_pipeline()


def _flatten_text(value: Any) -> list[str]:
    """Read PaddleOCR-VL Markdown output across minor result-shape changes."""
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, (list, tuple)):
        parts: list[str] = []
        for item in value:
            parts.extend(_flatten_text(item))
        return parts
    if isinstance(value, dict):
        for key in ("markdown_texts", "markdown_text", "text"):
            if key in value:
                parts = _flatten_text(value[key])
                if parts:
                    return parts
        return []
    return []


def _fallback_text(value: Any) -> list[str]:
    """Extract text-bearing fields from the structured result when Markdown is absent."""
    text_keys = {"rec_texts", "rec_text", "block_content", "text_content", "markdown_text", "text"}
    if isinstance(value, str):
        return []
    if isinstance(value, (list, tuple)):
        parts: list[str] = []
        for item in value:
            parts.extend(_fallback_text(item))
        return parts
    if isinstance(value, dict):
        parts: list[str] = []
        for key, item in value.items():
            if str(key).lower() in text_keys:
                parts.extend(_flatten_text(item))
            else:
                parts.extend(_fallback_text(item))
        return parts
    return []


def _result_text(result: Any) -> str:
    markdown = getattr(result, "markdown", None)
    parts = _flatten_text(markdown)
    if not parts:
        structured = getattr(result, "json", None)
        if callable(structured):
            structured = structured()
        parts = _fallback_text(structured)

    # Preserve order while removing exact duplicate paragraphs emitted by some pipelines.
    unique: list[str] = []
    seen: set[str] = set()
    for part in parts:
        cleaned = part.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            unique.append(cleaned)
    return "\n".join(unique)


def recognize(image_base64: str) -> dict[str, Any]:
    """Recognize a JPEG supplied as plain base64; return the frontend API shape."""
    if not isinstance(image_base64, str) or not image_base64.strip():
        raise ValueError("缺少图片数据")

    encoded = image_base64.strip()
    if encoded.startswith("data:") and "," in encoded:
        encoded = encoded.split(",", 1)[1]
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("图片不是有效的 Base64 数据") from exc
    if not image_bytes:
        raise ValueError("图片内容为空")
    if len(image_bytes) > 8 * 1024 * 1024:
        raise ValueError("图片过大，请重新拍摄或压缩后上传")

    temp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as image_file:
            image_file.write(image_bytes)
            temp_path = image_file.name

        with _inference_lock:
            results = list(_get_pipeline().predict(temp_path))
        text = "\n\n".join(filter(None, (_result_text(item) for item in results)))
        if not text:
            raise RuntimeError("模型未返回可显示的文字，请换一张更清晰的标签照片")

        # PaddleOCR-VL's document result does not expose a stable per-word confidence
        # field through this adapter, so do not invent low-confidence token scores.
        return {"text": text, "lowConf": [], "engine": "PaddleOCR-VL"}
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
