import os
import json
import logging
import hashlib
import time
import httpx
from fastapi import FastAPI, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from urllib.parse import urlparse, parse_qs

from curl_cffi.requests import AsyncSession

try:
    import redis.asyncio as aioredis
    _REDIS_AVAILABLE = True
except ImportError:
    _REDIS_AVAILABLE = False

from extractors import animego, kodik, aniboom, sibnet, anilibria, jutsu

FLARESOLVERR_URL = os.getenv("FLARESOLVERR_URL", "http://flaresolverr:8191")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
PARSE_CACHE_TTL = 600   # 10 min
SEARCH_CACHE_TTL = 300  # 5 min
PLAYERS_CACHE_TTL = 300 # 5 min

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("parser-service")

app = FastAPI(title="WatchSync Parser Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# httpx client — for Kodik/Aniboom iframes
_httpx_client: Optional[httpx.AsyncClient] = None


def get_httpx_client() -> httpx.AsyncClient:
    global _httpx_client
    if _httpx_client is None or _httpx_client.is_closed:
        _httpx_client = httpx.AsyncClient(
            timeout=30,
            follow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            },
        )
    return _httpx_client


# ─── Redis parse cache ────────────────────────────────────────────────────────

_redis_client: Optional[Any] = None


async def get_redis():
    global _redis_client
    if not _REDIS_AVAILABLE:
        return None
    if _redis_client is None:
        try:
            _redis_client = aioredis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2)
            await _redis_client.ping()
            log.info("Connected to Redis for parse cache")
        except Exception as e:
            log.warning("Redis unavailable (parse cache disabled): %s", e)
            _redis_client = None
    return _redis_client


def _cache_key(prefix: str, *parts: str) -> str:
    raw = "|".join(parts)
    return f"parser:{prefix}:{hashlib.md5(raw.encode()).hexdigest()}"


async def cache_get(key: str) -> Optional[Any]:
    r = await get_redis()
    if not r:
        return None
    try:
        val = await r.get(key)
        return json.loads(val) if val else None
    except Exception:
        return None


async def cache_set(key: str, value: Any, ttl: int) -> None:
    r = await get_redis()
    if not r:
        return
    try:
        await r.set(key, json.dumps(value, ensure_ascii=False), ex=ttl)
    except Exception:
        pass


def make_fetch_fn(cookie_str: str):
    """Returns a fetch_html function that uses Chrome TLS + user cookies."""
    async def fetch_html(url: str, referer: str = "", extra_headers: dict = {}) -> str:
        session = AsyncSession(impersonate="chrome124")
        headers = {
            "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Upgrade-Insecure-Requests": "1",
        }
        if referer:
            headers["Referer"] = referer
        if cookie_str:
            headers["Cookie"] = cookie_str
        headers.update(extra_headers)
        try:
            resp = await session.get(url, headers=headers, timeout=30)
            if resp.status_code >= 400:
                raise httpx.HTTPStatusError(
                    f"HTTP {resp.status_code}",
                    request=None,
                    response=type("R", (), {"status_code": resp.status_code})(),
                )
            return resp.text
        finally:
            await session.close()
    return fetch_html


async def _fetch_via_flaresolverr(url: str) -> str:
    """Fetch a URL through FlareSolverr headless Chrome (bypasses Cloudflare Bot Fight Mode)."""
    payload = {"cmd": "request.get", "url": url, "maxTimeout": 60000}
    async with httpx.AsyncClient(timeout=90) as client:
        resp = await client.post(f"{FLARESOLVERR_URL}/v1", json=payload)
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") != "ok":
            raise RuntimeError(f"FlareSolverr error: {data.get('message', data)}")
        solution = data.get("solution", {})
        html = solution.get("response", "")
        if not html:
            raise RuntimeError("FlareSolverr returned empty response")
        return html


def make_fetch_with_cf_fallback(cookie_str: str):
    """fetch_html that falls back to FlareSolverr if animego returns 403/429."""
    direct_fetch = make_fetch_fn(cookie_str)

    async def fetch_html(url: str, referer: str = "", extra_headers: dict = {}) -> str:
        try:
            return await direct_fetch(url, referer, extra_headers)
        except httpx.HTTPStatusError as e:
            code = getattr(getattr(e, "response", None), "status_code", 0)
            if code in (403, 429):
                log.warning("Got %s from %s — retrying via FlareSolverr", code, url)
                return await _fetch_via_flaresolverr(url)
            raise

    return fetch_html


# ─── Inject cache (bookmarklet data from user's browser) ───────────────────────

_inject_cache: Dict[str, Any] = {}
INJECT_TTL = 3600 * 24  # 24 hours


def _inject_key(url: str) -> str:
    return hashlib.md5(url.rstrip("/").encode()).hexdigest()[:12]


def _episodes_to_seasons(episodes: list) -> list:
    seen: dict = {}
    for ep in episodes:
        sid = str(ep.get("season", ep.get("season_id", "1")))
        if sid not in seen:
            seen[sid] = {"id": sid, "title": f"Сезон {sid}"}
    return list(seen.values())


def _purge_inject_cache():
    now = time.time()
    expired = [k for k, v in _inject_cache.items() if now - v.get("timestamp", 0) > INJECT_TTL]
    for k in expired:
        del _inject_cache[k]


# ─── Models ────────────────────────────────────────────────────────────────────

class ParseRequest(BaseModel):
    url: str
    cookies: str = ""   # optional: user's browser cookies for animego.me


class ExtractRequest(BaseModel):
    url: str
    episode_id: str
    iframe_url: str
    player_type: str
    cookies: str = ""


class InjectRequest(BaseModel):
    url: str
    title: str = ""
    episodes: List[Dict[str, Any]] = []


# ─── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "parser-service"}


@app.get("/api/v1/anime/search")
async def search_anime(
    q: str = Query(..., min_length=2),
    source: str = Query(default="animego"),
    x_anime_cookies: str = Header(default=""),
):
    ck = _cache_key("search", source, q.lower().strip())
    if cached := await cache_get(ck):
        return cached
    try:
        if source == "anilibria":
            results = await anilibria.search(q, get_httpx_client())
        else:
            fetch = make_fetch_with_cf_fallback(x_anime_cookies)
            results = await animego.search(q, get_httpx_client(), fetch)
        resp = {"results": results, "source": source}
        await cache_set(ck, resp, SEARCH_CACHE_TTL)
        return resp
    except Exception as e:
        log.exception("Search failed")
        code = getattr(getattr(e, "response", None), "status_code", 500)
        raise HTTPException(status_code=502 if isinstance(code, int) and 400 <= code < 600 else 500, detail=str(e))


@app.get("/api/v1/anime/anilibria/episodes")
async def anilibria_episodes(id: str = Query(...)):
    """Return episode list for an anilibria.tv release by ID."""
    ck = _cache_key("anilibria_eps", id)
    if cached := await cache_get(ck):
        return cached
    try:
        eps = await anilibria.get_episodes(id, get_httpx_client())
        resp = {"episodes": eps, "release_id": id}
        await cache_set(ck, resp, PARSE_CACHE_TTL)
        return resp
    except Exception as e:
        log.exception("Anilibria episodes fetch failed")
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/v1/anime/jutsu/episodes")
async def jutsu_episodes(url: str = Query(...)):
    """Return episode list for a jut.su anime page."""
    ck = _cache_key("jutsu_eps", url)
    if cached := await cache_get(ck):
        return cached
    try:
        eps = await jutsu.get_episodes(url, get_httpx_client())
        resp = {"episodes": eps, "url": url}
        await cache_set(ck, resp, PARSE_CACHE_TTL)
        return resp
    except Exception as e:
        log.exception("Jutsu episodes fetch failed")
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/v1/anime/inject")
async def inject_anime_data(req: InjectRequest):
    _purge_inject_cache()
    key = _inject_key(req.url)
    _inject_cache[key] = {
        "url": req.url,
        "title": req.title,
        "episodes": req.episodes,
        "timestamp": time.time(),
    }
    log.info("Injected %d episodes for %s (key=%s)", len(req.episodes), req.url, key)
    return {"key": key, "episodes_count": len(req.episodes), "url": req.url}


@app.get("/api/v1/anime/inject/{key}")
async def get_injected_data(key: str):
    data = _inject_cache.get(key)
    if not data:
        raise HTTPException(status_code=404, detail="No injected data for this key")
    return data


@app.post("/api/v1/anime/parse")
async def parse_anime(req: ParseRequest):
    try:
        # Check bookmarklet inject cache first — avoids hitting DDoS-Guard protected pages
        key = _inject_key(req.url)
        cached = _inject_cache.get(key)
        if cached and time.time() - cached.get("timestamp", 0) < INJECT_TTL:
            episodes = cached.get("episodes", [])
            log.info("parse_anime: serving injected data for %s (%d eps)", req.url, len(episodes))
            return {
                "title": cached.get("title", ""),
                "url": req.url,
                "poster": "",
                "seasons": _episodes_to_seasons(episodes),
                "episodes": episodes,
                "players": [],
                "from_inject": True,
            }
        ck = _cache_key("parse", req.url.rstrip("/"))
        if redis_cached := await cache_get(ck):
            log.info("parse_anime: Redis cache HIT for %s", req.url)
            return redis_cached
        fetch = make_fetch_with_cf_fallback(req.cookies)
        data = await animego.parse_anime(req.url, get_httpx_client(), fetch)
        await cache_set(ck, data, PARSE_CACHE_TTL)
        return data
    except Exception as e:
        log.exception("Parse failed")
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/v1/anime/players")
async def get_episode_players(req: ParseRequest):
    parsed = urlparse(req.url)
    qs = parse_qs(parsed.query)
    episode_id = (qs.get("episode") or qs.get("ep") or [""])[0]
    anime_url = parsed.scheme + "://" + parsed.netloc + parsed.path

    if not episode_id:
        raise HTTPException(status_code=400, detail="episode_id required (?episode=N)")

    try:
        ck = _cache_key("players", anime_url, episode_id)
        if redis_cached := await cache_get(ck):
            log.info("players: Redis cache HIT for ep %s", episode_id)
            return redis_cached
        fetch = make_fetch_with_cf_fallback(req.cookies)
        players = await animego.fetch_episode_players(anime_url, episode_id, get_httpx_client(), fetch)
        resp = {"players": players}
        await cache_set(ck, resp, PLAYERS_CACHE_TTL)
        return resp
    except Exception as e:
        log.exception("Players fetch failed")
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/v1/anime/extract")
async def extract_stream(req: ExtractRequest):
    try:
        streams = []
        ptype = req.player_type.lower()

        if ptype == "kodik" or "kodik" in req.iframe_url:
            streams = await kodik.extract(req.iframe_url, get_httpx_client())
        elif ptype == "aniboom" or "aniboom" in req.iframe_url:
            streams = await aniboom.extract(req.iframe_url, get_httpx_client())
        elif ptype == "sibnet" or "sibnet" in req.iframe_url:
            streams = await sibnet.extract(req.iframe_url, get_httpx_client())
        elif ptype == "anilibria" or "anilibria" in req.iframe_url:
            streams = await anilibria.extract(req.iframe_url, get_httpx_client())
        elif ptype == "jutsu" or "jut.su" in req.iframe_url:
            streams = await jutsu.extract(req.iframe_url, get_httpx_client())
        else:
            try:
                streams = await kodik.extract(req.iframe_url, get_httpx_client())
            except Exception:
                pass
            if not streams:
                try:
                    streams = await aniboom.extract(req.iframe_url, get_httpx_client())
                except Exception:
                    pass
            if not streams:
                try:
                    streams = await sibnet.extract(req.iframe_url, get_httpx_client())
                except Exception:
                    pass
            if not streams:
                try:
                    streams = await anilibria.extract(req.iframe_url, get_httpx_client())
                except Exception:
                    pass
            if not streams:
                streams = await jutsu.extract(req.iframe_url, get_httpx_client())

        if not streams:
            raise HTTPException(status_code=422, detail="Could not extract streams from this player")

        return {"streams": streams}

    except HTTPException:
        raise
    except Exception as e:
        log.exception("Extract failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.on_event("shutdown")
async def shutdown():
    if _httpx_client and not _httpx_client.is_closed:
        await _httpx_client.aclose()
    if _redis_client:
        await _redis_client.aclose()


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
