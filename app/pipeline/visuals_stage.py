"""
Stage 3: turn each segment's visual_prompt into a still image, which
assemble_stage then animates with a Ken Burns pan/zoom. Pluggable provider:
  - "openai"      : gpt-image-1 via the Images API
  - "stability"    : Stable Image Core via the Stability API
  - "placeholder"  : no key needed -- renders a nice gradient card with the
                     prompt text on it, so you can test the whole pipeline
                     (and see exactly what each beat's visual *would* be)
                     before paying for real image generation.
"""
import base64
import textwrap
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFilter

from ..settings_store import get_setting

WIDTH, HEIGHT = 1080, 1920  # vertical, matches Shorts/Reels/TikTok -- the "short" default
LONGFORM_WIDTH, LONGFORM_HEIGHT = 1920, 1080  # horizontal, matches a real long-form YouTube video


def _dims(kind: str) -> tuple[int, int]:
    return (LONGFORM_WIDTH, LONGFORM_HEIGHT) if kind == "longform" else (WIDTH, HEIGHT)


def _placeholder_image(prompt: str, out_path: Path, kind: str = "short", seed: int = 0):
    # Deterministic-ish gradient per prompt so repeated runs of the same script look distinct.
    w, h_px = _dims(kind)
    h = abs(hash(prompt)) % 360
    top = _hsl_to_rgb(h, 0.55, 0.28)
    bottom = _hsl_to_rgb((h + 40) % 360, 0.55, 0.12)
    img = Image.new("RGB", (w, h_px), top)
    draw = ImageDraw.Draw(img)
    for y in range(h_px):
        t = y / h_px
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))
    img = img.filter(ImageFilter.GaussianBlur(2))
    draw = ImageDraw.Draw(img)
    wrapped = textwrap.fill(prompt, width=26 if kind != "longform" else 60)
    draw.multiline_text((80, h_px // 2 - 200), wrapped, fill=(255, 255, 255), spacing=14)
    draw.text((80, h_px - 120), "PLACEHOLDER IMAGE — set an image_provider API key in Settings",
               fill=(255, 255, 255, 180))
    img.save(out_path)


def _hsl_to_rgb(h, s, l):
    import colorsys
    r, g, b = colorsys.hls_to_rgb(h / 360, l, s)
    return int(r * 255), int(g * 255), int(b * 255)


def _openai_image(db, prompt: str, out_path: Path, kind: str = "short"):
    api_key = get_setting(db, "openai_api_key")
    size = "1536x1024" if kind == "longform" else "1024x1536"  # gpt-image-1's landscape vs portrait sizes
    resp = requests.post(
        "https://api.openai.com/v1/images/generations",
        headers={"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
        json={"model": "gpt-image-1", "prompt": prompt, "size": size},
        timeout=120,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"OpenAI image generation failed ({resp.status_code}): {resp.text[:500]}")
    b64 = resp.json()["data"][0]["b64_json"]
    out_path.write_bytes(base64.b64decode(b64))


def _stability_image(db, prompt: str, out_path: Path, kind: str = "short"):
    api_key = get_setting(db, "stability_api_key")
    aspect_ratio = "16:9" if kind == "longform" else "9:16"
    resp = requests.post(
        "https://api.stability.ai/v2beta/stable-image/generate/core",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "image/*"},
        files={"none": ""},
        data={"prompt": prompt, "aspect_ratio": aspect_ratio, "output_format": "png"},
        timeout=120,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Stability image generation failed ({resp.status_code}): {resp.text[:500]}")
    out_path.write_bytes(resp.content)


def _gemini_image(db, prompt: str, out_path: Path):
    # No explicit aspect-ratio parameter on this endpoint -- the orientation
    # hint baked into `prompt` by generate_image (below) is what actually
    # steers it, same as it always has for the vertical/short case.
    api_key = get_setting(db, "gemini_api_key")
    model = get_setting(db, "gemini_image_model", "gemini-2.5-flash-image")
    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": api_key, "content-type": "application/json"},
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["IMAGE"]},
        },
        timeout=120,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini image generation failed ({resp.status_code}): {resp.text[:500]}")
    parts = resp.json()["candidates"][0]["content"]["parts"]
    for part in parts:
        if "inlineData" in part:
            out_path.write_bytes(base64.b64decode(part["inlineData"]["data"]))
            return
    raise RuntimeError("Gemini image generation returned no image data")


def generate_image(db, prompt: str, style_suffix: str, out_path: Path, kind: str = "short"):
    provider = get_setting(db, "image_provider", "placeholder")
    orientation = "Horizontal 16:9 cinematic frame" if kind == "longform" else "Vertical 9:16 cinematic frame"
    full_prompt = f"{prompt}. {style_suffix}".strip().rstrip(".") + \
                  f". {orientation}, no text or watermarks."
    try:
        if provider == "openai" and get_setting(db, "openai_api_key"):
            return _openai_image(db, full_prompt, out_path, kind)
        if provider == "stability" and get_setting(db, "stability_api_key"):
            return _stability_image(db, full_prompt, out_path, kind)
        if provider == "gemini" and get_setting(db, "gemini_api_key"):
            return _gemini_image(db, full_prompt, out_path)
    except Exception as e:
        raise RuntimeError(f"Image generation via {provider} failed: {e}")
    _placeholder_image(prompt, out_path, kind)
