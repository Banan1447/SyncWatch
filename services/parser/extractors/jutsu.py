import re
import json
import httpx
from typing import Optional
from urllib.parse import urljoin


JUTSU_BASE = "https://jut.su"
JUTSU_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://jut.su/",
    "Accept-Language": "ru-RU,ru;q=0.9",
}


async def extract(embed_url: str, client: httpx.AsyncClient) -> list[dict]:
    """
    Extract stream URLs from jut.su episode page.
    Accepts:
    - https://jut.su/{anime-slug}/episode-{N}.html
    - https://jut.su/{anime-slug}/season-{S}/episode-{N}.html
    Returns list of {label, url, headers}
    """
    if embed_url.startswith("//"):
        embed_url = "https:" + embed_url

    try:
        resp = await client.get(embed_url, headers=JUTSU_HEADERS, follow_redirects=True, timeout=20)
        resp.raise_for_status()
    except Exception:
        return []

    html = resp.text
    return _parse_streams(html, embed_url)


def _parse_streams(html: str, page_url: str) -> list[dict]:
    streams = []

    # Pattern 1: JSON object with hls quality map
    # {"360":"https://...m3u8","480":"https://...m3u8","720":"https://...m3u8"}
    m = re.search(r'var\s+\w*[Qq]uality\w*\s*=\s*(\{[^}]+\})', html)
    if not m:
        m = re.search(r'player_quality_list\s*=\s*(\{[^}]+\})', html)
    if m:
        try:
            qmap = json.loads(m.group(1))
            for label, url in sorted(qmap.items(), key=lambda x: -int(x[0]) if x[0].isdigit() else 0):
                if url and any(ext in url for ext in [".m3u8", ".mp4", ".webm"]):
                    streams.append({
                        "label": f"{label}p" if label.isdigit() else label,
                        "url": url,
                        "headers": {"Referer": JUTSU_BASE + "/"},
                    })
            if streams:
                return streams
        except (json.JSONDecodeError, ValueError):
            pass

    # Pattern 2: file: "...m3u8" in player setup JS
    # jwplayer("player").setup({file: "...", ...})
    m = re.search(r'(?:file|src)\s*:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', html)
    if m:
        streams.append({
            "label": "auto",
            "url": m.group(1),
            "headers": {"Referer": JUTSU_BASE + "/"},
        })
        return streams

    # Pattern 3: <source src="..."> HTML5 video tags
    sources = re.findall(r'<source[^>]+src=["\']([^"\']+)["\'][^>]*(?:label=["\']([^"\']*)["\'])?', html)
    for src, label in sources:
        if any(ext in src for ext in [".m3u8", ".mp4", ".webm"]):
            if not src.startswith("http"):
                src = urljoin(page_url, src)
            streams.append({
                "label": label or "auto",
                "url": src,
                "headers": {"Referer": JUTSU_BASE + "/"},
            })
    if streams:
        return streams

    # Pattern 4: data-file attribute
    m = re.search(r'data-file=["\']([^"\']+\.m3u8[^"\']*)["\']', html)
    if m:
        streams.append({
            "label": "auto",
            "url": m.group(1),
            "headers": {"Referer": JUTSU_BASE + "/"},
        })

    return streams


async def get_episodes(anime_url: str, client: httpx.AsyncClient) -> list[dict]:
    """
    Fetch episode list for a jut.su anime page.
    anime_url: https://jut.su/{slug}/
    Returns list of {episode, season, title, url}
    """
    try:
        resp = await client.get(anime_url, headers=JUTSU_HEADERS, follow_redirects=True, timeout=20)
        resp.raise_for_status()
    except Exception:
        return []

    html = resp.text
    episodes = []

    # Episode links: /slug/episode-N.html or /slug/season-S/episode-N.html
    links = re.findall(
        r'href=["\'](' + re.escape(JUTSU_BASE) + r'/[^"\']+/(?:season-(\d+)/)?episode-(\d+)\.html)["\']',
        html,
    )
    seen = set()
    for url, season, ep_num in links:
        if url in seen:
            continue
        seen.add(url)
        episodes.append({
            "id": f"s{season or 1}e{ep_num}",
            "episode": ep_num,
            "season": season or "1",
            "title": f"Эпизод {ep_num}",
            "url": url,
        })

    episodes.sort(key=lambda x: (int(x["season"]), int(x["episode"])))
    return episodes
