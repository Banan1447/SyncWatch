import re
import httpx
from typing import Optional


ANILIBRIA_API = "https://api.anilibria.tv/v3"
ANILIBRIA_CDN_HOSTS = [
    "https://cache1.anilibria.tv",
    "https://cache2.anilibria.tv",
    "https://static-libria.weekstorm.one",
]

ANILIBRIA_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.anilibria.tv/",
    "Origin": "https://www.anilibria.tv",
}


async def extract(embed_url: str, client: httpx.AsyncClient) -> list[dict]:
    """
    Extract stream URLs from anilibria.tv.
    Accepts:
    - Player embed: https://player.anilibria.tv/index.html#release_id=NNN&episode=N
    - Release page: https://www.anilibria.tv/release/code.html
    - Direct API: https://api.anilibria.tv/...
    Returns list of {label, url, headers}
    """
    if embed_url.startswith("//"):
        embed_url = "https:" + embed_url

    release_id, episode_num = _parse_embed_url(embed_url)

    if release_id:
        return await _fetch_by_id(release_id, episode_num, client)

    code = _parse_release_code(embed_url)
    if code:
        return await _fetch_by_code(code, episode_num, client)

    return []


def _parse_embed_url(url: str):
    """Parse player.anilibria.tv embed URL. Returns (release_id, episode_num)."""
    # https://player.anilibria.tv/index.html#release_id=9999&episode=1
    # https://player.anilibria.tv/?release_id=9999&episode=1
    m = re.search(r'release_id=(\d+)', url)
    rid = m.group(1) if m else None
    m2 = re.search(r'episode=(\d+)', url)
    ep = int(m2.group(1)) if m2 else 1
    return rid, ep


def _parse_release_code(url: str) -> Optional[str]:
    """Parse release code from https://www.anilibria.tv/release/code.html"""
    m = re.search(r'/release/([^/\s?#]+?)(?:\.html)?(?:[?#]|$)', url)
    return m.group(1) if m else None


async def _fetch_by_id(release_id: str, episode: int, client: httpx.AsyncClient) -> list[dict]:
    url = f"{ANILIBRIA_API}/title?id={release_id}"
    try:
        resp = await client.get(url, headers=ANILIBRIA_HEADERS, timeout=15)
        resp.raise_for_status()
        return _extract_streams(resp.json(), episode)
    except Exception:
        return []


async def _fetch_by_code(code: str, episode: int, client: httpx.AsyncClient) -> list[dict]:
    url = f"{ANILIBRIA_API}/title?code={code}"
    try:
        resp = await client.get(url, headers=ANILIBRIA_HEADERS, timeout=15)
        resp.raise_for_status()
        return _extract_streams(resp.json(), episode)
    except Exception:
        return []


def _extract_streams(data: dict, episode: int) -> list[dict]:
    """Extract HLS URLs from anilibria API title response."""
    streams = []
    player = data.get("player", {})
    host = player.get("host")
    if not host:
        host = ANILIBRIA_CDN_HOSTS[0]
    elif not host.startswith("http"):
        host = "https://" + host

    ep_list = player.get("list", {})
    ep_data = ep_list.get(str(episode)) or ep_list.get(str(int(episode)))
    if not ep_data and ep_list:
        # Fallback: take first available episode
        ep_data = next(iter(ep_list.values()))

    if not ep_data:
        return streams

    hls = ep_data.get("hls", {})
    quality_map = [
        ("fhd", "1080p"),
        ("hd", "720p"),
        ("sd", "480p"),
    ]
    for key, label in quality_map:
        path = hls.get(key)
        if not path:
            continue
        full_url = path if path.startswith("http") else host + path
        streams.append({
            "label": label,
            "url": full_url,
            "headers": {"Referer": "https://www.anilibria.tv/"},
        })

    return streams


async def search(query: str, client: httpx.AsyncClient) -> list[dict]:
    """Search for anime titles on anilibria.tv API."""
    url = f"{ANILIBRIA_API}/title/search?search={query}&limit=10"
    try:
        resp = await client.get(url, headers=ANILIBRIA_HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        results = []
        for item in data.get("list", []):
            names = item.get("names", {})
            title = names.get("ru") or names.get("en") or str(item.get("id"))
            code = item.get("code", "")
            results.append({
                "id": str(item.get("id")),
                "code": code,
                "title": title,
                "url": f"https://www.anilibria.tv/release/{code}.html",
                "poster": _get_poster(item),
                "episodes_count": item.get("player", {}).get("episodes", {}).get("last", 0),
            })
        return results
    except Exception:
        return []


def _get_poster(item: dict) -> str:
    posters = item.get("posters", {})
    for size in ("original", "medium", "small"):
        p = posters.get(size, {})
        if isinstance(p, dict):
            url = p.get("url", "")
            if url:
                return url if url.startswith("http") else "https://www.anilibria.tv" + url
    return ""


async def get_episodes(release_id: str, client: httpx.AsyncClient) -> list[dict]:
    """Return episode list for a release."""
    url = f"{ANILIBRIA_API}/title?id={release_id}"
    try:
        resp = await client.get(url, headers=ANILIBRIA_HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        player = data.get("player", {})
        ep_list = player.get("list", {})
        episodes = []
        for ep_num, ep_data in sorted(ep_list.items(), key=lambda x: float(x[0])):
            episodes.append({
                "id": ep_num,
                "episode": ep_num,
                "title": ep_data.get("name") or f"Эпизод {ep_num}",
                "preview": ep_data.get("preview", ""),
            })
        return episodes
    except Exception:
        return []
