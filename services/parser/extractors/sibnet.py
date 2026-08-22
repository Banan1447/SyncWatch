import re
import httpx
from typing import Optional


SIBNET_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://video.sibnet.ru/",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8",
}

SIBNET_BASE = "https://video.sibnet.ru"


async def extract(embed_url: str, client: httpx.AsyncClient) -> list[dict]:
    """
    Extract stream URLs from a Sibnet embed/video page.
    Supports:
    - https://video.sibnet.ru/shell.php?videoid=...
    - https://video.sibnet.ru/video<id>/
    Returns list of {label, url, headers}
    """
    if embed_url.startswith("//"):
        embed_url = "https:" + embed_url

    resp = await client.get(
        embed_url,
        headers=SIBNET_HEADERS,
        follow_redirects=True,
        timeout=15,
    )
    resp.raise_for_status()
    html = resp.text

    streams = _parse_player_src(html, embed_url)
    if not streams:
        # Try shell.php redirect — sometimes the page embeds it via iframe
        video_id = _extract_video_id(embed_url)
        if video_id:
            shell_url = f"{SIBNET_BASE}/shell.php?videoid={video_id}&autoPlay=0"
            try:
                r2 = await client.get(shell_url, headers=SIBNET_HEADERS, follow_redirects=True, timeout=15)
                if r2.status_code == 200:
                    streams = _parse_player_src(r2.text, shell_url)
            except Exception:
                pass

    return streams


def _extract_video_id(url: str) -> Optional[str]:
    m = re.search(r"videoid=(\d+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/video(\d+)", url)
    if m:
        return m.group(1)
    return None


def _parse_player_src(html: str, base_url: str) -> list[dict]:
    streams = []

    # Pattern 1: player.src = [{"file":"...","label":"..."},...] — jwplayer/videojs style
    m = re.search(r'player\s*\.\s*src\s*=\s*(\[.+?\])', html, re.DOTALL)
    if not m:
        m = re.search(r'\.setup\s*\(\s*\{[^}]*["\'"]sources["\'"]?\s*:\s*(\[.+?\])', html, re.DOTALL)
    if not m:
        m = re.search(r'sources\s*:\s*(\[.+?\])', html, re.DOTALL)

    if m:
        block = m.group(1)
        files = re.findall(r'"file"\s*:\s*"([^"]+)"', block)
        labels = re.findall(r'"label"\s*:\s*"([^"]+)"', block)
        for i, f in enumerate(files):
            if not f.startswith("http"):
                f = SIBNET_BASE + f
            label = labels[i] if i < len(labels) else f"Q{i+1}"
            streams.append({
                "label": label,
                "url": f,
                "headers": {"Referer": SIBNET_BASE + "/"},
            })
        if streams:
            return streams

    # Pattern 2: <source src="..."> in HTML5 video
    sources = re.findall(r'<source[^>]+src=["\']([^"\']+)["\'][^>]*>', html)
    for src in sources:
        if not src.startswith("http"):
            src = SIBNET_BASE + src
        if any(ext in src for ext in [".mp4", ".webm", ".m3u8"]):
            streams.append({
                "label": "auto",
                "url": src,
                "headers": {"Referer": SIBNET_BASE + "/"},
            })
    if streams:
        return streams

    # Pattern 3: direct redirect — if we ended up at a video URL
    final_url = base_url
    if any(ext in final_url for ext in [".mp4", ".webm", ".m3u8"]):
        streams.append({
            "label": "auto",
            "url": final_url,
            "headers": {"Referer": SIBNET_BASE + "/"},
        })

    return streams
