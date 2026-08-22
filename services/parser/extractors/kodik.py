import re
import base64
import httpx
from typing import Optional


KODIK_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://kodik.info/",
    "Origin": "https://kodik.info",
}


def _decode_url(encoded: str) -> str:
    # Kodik encodes URL as base64(reversed(url))
    # Sometimes has extra chars — try direct then with padding
    try:
        decoded = base64.b64decode(encoded[::-1] + "==").decode("utf-8")
        if decoded.startswith("//") or decoded.startswith("http"):
            return decoded
    except Exception:
        pass
    # Strip known prefix if present
    if "=" in encoded:
        encoded = encoded.split("=")[0]
    decoded = base64.b64decode(encoded[::-1] + "==").decode("utf-8")
    return decoded


async def extract(iframe_url: str, client: httpx.AsyncClient) -> list[dict]:
    """
    Given a kodik iframe URL, returns list of stream dicts:
    [{label, url, headers: {Referer}}]
    """
    # Normalize URL
    if iframe_url.startswith("//"):
        iframe_url = "https:" + iframe_url

    # 1. Fetch the iframe page to get form params
    resp = await client.get(
        iframe_url,
        headers={**KODIK_HEADERS, "Referer": "https://animego.me/"},
        follow_redirects=True,
        timeout=15,
    )
    resp.raise_for_status()
    html = resp.text

    # 2. Extract params from the page JS
    params = _extract_params(html)
    if not params:
        return []

    # 3. POST to /ftor (or /gvi for some endpoints) to get encoded URLs
    ftor_url = re.sub(r"(https?://[^/]+)/.*", r"\1/ftor", iframe_url)
    # Also check for /gvi endpoint
    if "/seria/" in iframe_url or "/film/" in iframe_url:
        api_path = "/ftor"
    else:
        api_path = "/gvi"
    api_url = re.sub(r"(https?://[^/]+)/.*", r"\1" + api_path, iframe_url)

    payload = {
        "d": params["d"],
        "d_sign": params["d_sign"],
        "ref": params.get("ref", ""),
        "ref_sign": params.get("ref_sign", ""),
        "type": params.get("type", "seria"),
        "hash": params.get("hash", ""),
        "id": params.get("id", ""),
    }

    post_headers = {
        **KODIK_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": iframe_url,
        "Origin": re.match(r"https?://[^/]+", iframe_url).group(0),
    }

    resp2 = await client.post(
        api_url,
        data=payload,
        headers=post_headers,
        timeout=15,
    )
    resp2.raise_for_status()
    data = resp2.json()

    # 4. Decode links
    streams = []
    links = data.get("links") or data.get("src") or {}

    if isinstance(links, dict):
        for quality, variants in links.items():
            if isinstance(variants, list):
                for v in variants:
                    src = v.get("src", "")
            else:
                src = variants if isinstance(variants, str) else ""
            if src:
                decoded = _decode_and_fix(src)
                if decoded:
                    streams.append({"label": quality, "url": decoded, "headers": {"Referer": "https://kodik.info/"}})
    elif isinstance(links, str) and links:
        decoded = _decode_and_fix(links)
        if decoded:
            streams.append({"label": "auto", "url": decoded, "headers": {"Referer": "https://kodik.info/"}})

    return streams


def _decode_and_fix(src: str) -> Optional[str]:
    try:
        url = _decode_url(src)
        if not url.startswith("http"):
            url = "https:" + url
        return url
    except Exception:
        return None


def _extract_params(html: str) -> Optional[dict]:
    params = {}
    patterns = {
        "d": r'["\']d["\']\s*:\s*["\']([^"\']+)["\']',
        "d_sign": r'["\']d_sign["\']\s*:\s*["\']([^"\']+)["\']',
        "ref": r'["\']ref["\']\s*:\s*["\']([^"\']*)["\']',
        "ref_sign": r'["\']ref_sign["\']\s*:\s*["\']([^"\']+)["\']',
        "type": r'["\']type["\']\s*:\s*["\']([^"\']+)["\']',
        "hash": r'["\']hash["\']\s*:\s*["\']([^"\']+)["\']',
        "id": r'["\']id["\']\s*:\s*["\']([^"\']+)["\']',
    }
    for key, pattern in patterns.items():
        m = re.search(pattern, html)
        if m:
            params[key] = m.group(1)

    # Must have at least d and d_sign
    if "d" not in params or "d_sign" not in params:
        # Try alternative: videoInfo object
        m = re.search(r"videoInfo\s*=\s*\{([^}]+)\}", html, re.DOTALL)
        if not m:
            return None
        block = m.group(1)
        for key, pattern in patterns.items():
            m2 = re.search(r'["\']' + key + r'["\']\s*:\s*["\']([^"\']+)["\']', block)
            if m2:
                params[key] = m2.group(1)

    return params if ("d" in params and "d_sign" in params) else None
