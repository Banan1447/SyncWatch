import re
import httpx


ANIBOOM_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}


async def extract(iframe_url: str, client: httpx.AsyncClient) -> list[dict]:
    """
    Given an aniboom embed URL, returns list of stream dicts:
    [{label, url, headers: {Referer}}]
    """
    if iframe_url.startswith("//"):
        iframe_url = "https:" + iframe_url

    # 1. Fetch embed page to get uuid and Bearer token
    resp = await client.get(
        iframe_url,
        headers={**ANIBOOM_HEADERS, "Referer": "https://animego.me/"},
        follow_redirects=True,
        timeout=15,
    )
    resp.raise_for_status()
    html = resp.text

    uuid = _extract_uuid(html)
    token = _extract_token(html)

    if not uuid or not token:
        return []

    # 2. POST /api/video with uuid
    origin = re.match(r"https?://[^/]+", iframe_url).group(0)
    api_url = f"{origin}/api/video"

    resp2 = await client.post(
        api_url,
        json={"uuid": uuid},
        headers={
            **ANIBOOM_HEADERS,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Referer": iframe_url,
            "Origin": origin,
        },
        timeout=15,
    )
    resp2.raise_for_status()
    data = resp2.json()

    streams = []
    src = data.get("src") or data.get("url") or data.get("hls") or ""
    if isinstance(src, str) and src:
        if src.startswith("//"):
            src = "https:" + src
        streams.append({"label": "auto", "url": src, "headers": {"Referer": origin + "/"}})

    # Some aniboom responses have quality variants
    if "qualities" in data:
        for q in data["qualities"]:
            url = q.get("src") or q.get("url") or ""
            if url.startswith("//"):
                url = "https:" + url
            if url:
                streams.append({"label": q.get("label", "auto"), "url": url, "headers": {"Referer": origin + "/"}})

    return streams


def _extract_uuid(html: str) -> str:
    # uuid is in the embed JS, format: uuid: "xxxxxxxx-..."
    m = re.search(r'["\']?uuid["\']?\s*[=:]\s*["\']([0-9a-f-]{36})["\']', html, re.IGNORECASE)
    return m.group(1) if m else ""


def _extract_token(html: str) -> str:
    # Token in script tag: Bearer token or apiKey
    for pattern in [
        r'Bearer\s+([A-Za-z0-9\-_\.]+)',
        r'apiKey\s*[=:]\s*["\']([^"\']+)["\']',
        r'token\s*[=:]\s*["\']([A-Za-z0-9\-_\.]{20,})["\']',
    ]:
        m = re.search(pattern, html)
        if m:
            return m.group(1)
    return ""
