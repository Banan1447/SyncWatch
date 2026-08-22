import re
import httpx
from bs4 import BeautifulSoup
from typing import Callable, Awaitable

BASE_URL = "https://animego.me"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "ru-RU,ru;q=0.9",
}

FetchFn = Callable[[str, str, dict], Awaitable[str]]


async def search(query: str, client: httpx.AsyncClient, fetch_html: FetchFn) -> list[dict]:
    url = f"{BASE_URL}/search/all?q={query}"

    # Try AJAX JSON endpoint first
    try:
        resp = await client.get(
            url,
            headers={**HEADERS, "X-Requested-With": "XMLHttpRequest"},
            timeout=20,
        )
        if resp.status_code in (403, 429, 500, 503):
            raise httpx.HTTPStatusError("blocked", request=resp.request, response=resp)
        resp.raise_for_status()
        try:
            data = resp.json()
            items = data.get("anime") or data.get("results") or data.get("data") or []
            results = []
            for item in items[:15]:
                results.append({
                    "title": item.get("title") or item.get("name") or "",
                    "url": _abs(item.get("url") or item.get("link") or ""),
                    "poster": item.get("poster") or item.get("image") or "",
                    "year": item.get("year") or "",
                })
            if results:
                return results
        except Exception:
            pass
    except (httpx.HTTPStatusError, httpx.RequestError):
        pass

    # Fallback: FlareSolverr fetch + HTML parse
    html = await fetch_html(url, "", {"X-Requested-With": "XMLHttpRequest"})
    soup = BeautifulSoup(html, "lxml")

    # Try JSON embedded in page
    script = soup.find("script", string=re.compile(r'"anime"\s*:'))
    if script:
        try:
            import json
            m = re.search(r'\{.*"anime".*\}', script.string, re.DOTALL)
            if m:
                data = json.loads(m.group(0))
                items = data.get("anime") or []
                results = []
                for item in items[:15]:
                    results.append({
                        "title": item.get("title") or item.get("name") or "",
                        "url": _abs(item.get("url") or ""),
                        "poster": item.get("poster") or "",
                        "year": item.get("year") or "",
                    })
                if results:
                    return results
        except Exception:
            pass

    # Parse HTML cards
    results = []
    for card in soup.select(".anime-grid-item, .animes-grid-item, [data-entry-id], .card")[:15]:
        a = card.select_one("a[href]")
        img = card.select_one("img")
        title_el = card.select_one(".title, .name, h3, h4, .card-title")
        if not a:
            continue
        title = (title_el.get_text(strip=True) if title_el else a.get("title", ""))
        if not title:
            continue
        results.append({
            "title": title,
            "url": _abs(a["href"]),
            "poster": img.get("src") or img.get("data-src") or "" if img else "",
            "year": "",
        })
    return results


async def parse_anime(url: str, client: httpx.AsyncClient, fetch_html: FetchFn) -> dict:
    html = await fetch_html(url, "", {})
    soup = BeautifulSoup(html, "lxml")

    title = ""
    for sel in ["h1", ".anime-title", "[itemprop='name']", ".show-title"]:
        el = soup.select_one(sel)
        if el:
            title = el.get_text(strip=True)
            break

    poster = ""
    for sel in [".anime-poster img", ".poster img", "[itemprop='image']", ".show-poster img"]:
        img = soup.select_one(sel)
        if img:
            poster = img.get("src") or img.get("data-src") or ""
            break

    episodes = _parse_episodes(soup)
    seasons = _extract_seasons(episodes)
    players = _parse_players(soup)

    return {
        "title": title,
        "url": url,
        "poster": poster,
        "seasons": seasons,
        "episodes": episodes,
        "players": players,
    }


async def fetch_episode_players(
    anime_url: str,
    episode_id: str,
    client: httpx.AsyncClient,
    fetch_html: FetchFn,
) -> list[dict]:
    ajax_url = f"{BASE_URL}/player?episode={episode_id}"
    try:
        resp = await client.get(
            ajax_url,
            headers={**HEADERS, "X-Requested-With": "XMLHttpRequest", "Referer": anime_url},
            timeout=20,
        )
        if resp.status_code in (403, 429, 500, 503):
            raise httpx.HTTPStatusError("blocked", request=resp.request, response=resp)
        resp.raise_for_status()
        try:
            data = resp.json()
            html_content = data.get("content") or data.get("html") or data.get("data") or resp.text
        except Exception:
            html_content = resp.text
    except (httpx.HTTPStatusError, httpx.RequestError):
        html_content = await fetch_html(ajax_url, anime_url, {"X-Requested-With": "XMLHttpRequest"})

    soup = BeautifulSoup(html_content, "lxml")
    return _extract_iframes(soup)


def _parse_episodes(soup: BeautifulSoup) -> list[dict]:
    episodes = []
    selectors = [
        "[data-episode-id]",
        ".video-player-episodes-list li[data-id]",
        ".episodes-list li[data-id]",
        "[data-episode]",
    ]
    for sel in selectors:
        found = soup.select(sel)
        if found:
            for ep in found:
                ep_id = ep.get("data-episode-id") or ep.get("data-id") or ep.get("data-episode") or ""
                number = ep.get("data-episode") or ep.get("data-number") or ep.get_text(strip=True) or ""
                season_id = ep.get("data-season") or ep.get("data-season-id") or "1"
                title = ep.get("title") or ep.get("data-title") or f"Эпизод {number}"
                if ep_id:
                    episodes.append({"id": str(ep_id), "season_id": str(season_id), "number": str(number), "title": title})
            break

    seen = set()
    unique = []
    for ep in episodes:
        if ep["id"] not in seen:
            seen.add(ep["id"])
            unique.append(ep)
    return unique


def _extract_seasons(episodes: list[dict]) -> list[dict]:
    seen = {}
    for ep in episodes:
        sid = ep["season_id"]
        if sid not in seen:
            seen[sid] = {"id": sid, "title": f"Сезон {sid}"}
    return list(seen.values())


def _parse_players(soup: BeautifulSoup) -> list[dict]:
    players = []
    seen = set()
    for el in soup.select("[data-player-id], .video-player-toggle-item, .player-btn, [data-player]"):
        pid = el.get("data-player-id") or el.get("data-id") or el.get("data-player") or ""
        name = el.get_text(strip=True) or el.get("title") or pid
        if pid and pid not in seen:
            seen.add(pid)
            players.append({"id": pid, "name": name})
    return players


def _extract_iframes(soup: BeautifulSoup) -> list[dict]:
    iframes = []
    seen = set()
    for iframe in soup.select("iframe[src], iframe[data-src]"):
        src = iframe.get("src") or iframe.get("data-src") or ""
        if not src or src in seen:
            continue
        seen.add(src)
        player_type = "unknown"
        if "kodik" in src:
            player_type = "kodik"
        elif "aniboom" in src or "animejoy" in src:
            player_type = "aniboom"
        elif "sibnet" in src:
            player_type = "sibnet"
        iframes.append({
            "player_id": src,
            "player_name": player_type,
            "iframe_url": src if src.startswith("http") else "https:" + src,
            "type": player_type,
        })
    return iframes


def _abs(url: str) -> str:
    if not url:
        return ""
    if url.startswith("http"):
        return url
    if url.startswith("//"):
        return "https:" + url
    return BASE_URL + url
