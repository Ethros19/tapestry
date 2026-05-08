"""archive.org client: search + item metadata + streaming URL helpers."""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

import httpx

SEARCH_URL = "https://archive.org/advancedsearch.php"
METADATA_URL = "https://archive.org/metadata/{identifier}"
DOWNLOAD_URL = "https://archive.org/download/{identifier}/{filename}"

# Highest priority first.
FORMAT_PRIORITY = ["24bit Flac", "Flac", "VBR MP3", "Ogg Vorbis"]
AUDIO_FORMATS = set(FORMAT_PRIORITY) | {"MP3", "256Kbps MP3", "128Kbps MP3"}

SEARCH_FIELDS = ["identifier", "title", "date", "creator", "collection", "description", "downloads"]


def _format_rank(fmt: str) -> int:
    try:
        return FORMAT_PRIORITY.index(fmt)
    except ValueError:
        return len(FORMAT_PRIORITY) + 1


def _track_index(track_field: Any) -> int:
    if track_field is None:
        return 10_000
    s = str(track_field).strip()
    if not s:
        return 10_000
    # Some items use "1/13" or similar.
    head = s.split("/")[0].split("-")[0].strip()
    try:
        return int(head)
    except ValueError:
        return 10_000


def build_query(q: str, year: str | None = None, fmt: str | None = "flac") -> str:
    """Compose a Lucene-style query from user inputs."""
    parts: list[str] = []
    if q and q.strip():
        parts.append(f"({q.strip()})")
    parts.append("mediatype:audio")
    if year:
        parts.append(f"date:{year}*")
    if fmt and fmt.lower() == "flac":
        parts.append("format:Flac")
    return " AND ".join(parts)


async def search(
    client: httpx.AsyncClient,
    q: str,
    year: str | None = None,
    fmt: str | None = "flac",
    rows: int = 50,
    start: int = 0,
) -> list[dict[str, Any]]:
    """Run an advanced search; return simplified result rows."""
    query = build_query(q, year=year, fmt=fmt)
    params: list[tuple[str, str]] = [
        ("q", query),
        ("output", "json"),
        ("rows", str(rows)),
        ("start", str(start)),
        ("sort[]", "downloads desc"),
    ]
    for f in SEARCH_FIELDS:
        params.append(("fl[]", f))

    r = await client.get(SEARCH_URL, params=params, timeout=15.0)
    r.raise_for_status()
    data = r.json()
    docs = data.get("response", {}).get("docs", [])

    results: list[dict[str, Any]] = []
    for d in docs:
        desc = d.get("description") or ""
        if isinstance(desc, list):
            desc = " ".join(desc)
        snippet = desc[:240].strip()
        date = d.get("date", "") or ""
        # archive.org returns "1973-11-04T00:00:00Z" — keep just the date.
        if "T" in date:
            date = date.split("T", 1)[0]
        creator = d.get("creator", "")
        if isinstance(creator, list):
            creator = ", ".join(creator)
        results.append({
            "identifier": d.get("identifier"),
            "title": d.get("title", ""),
            "date": date,
            "creator": creator,
            "description_snippet": snippet,
            "downloads": d.get("downloads", 0),
        })
    return results


def _human_size(n: int | None) -> str:
    if not n:
        return ""
    n = int(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def _format_length(length: Any) -> str:
    """Normalize archive.org length to mm:ss (or h:mm:ss for >1h)."""
    if not length:
        return ""
    s = str(length).strip()
    if not s:
        return ""
    if ":" in s:
        # already mm:ss or h:mm:ss
        return s
    try:
        secs = float(s)
    except ValueError:
        return s
    secs = int(round(secs))
    h, rem = divmod(secs, 3600)
    m, s_ = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s_:02d}"
    return f"{m}:{s_:02d}"


def _track_title(file: dict[str, Any]) -> str:
    """Best-effort track title: explicit `title` field, else strip dir + ext from `name`."""
    t = file.get("title")
    if t:
        return str(t)
    name = file.get("name", "")
    base = name.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[0] or name


def _is_default_title(track: dict[str, Any]) -> bool:
    """True if the track title was derived from the filename (no real metadata)."""
    title = (track.get("title") or "").strip()
    name = track.get("name", "")
    derived = name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return title == derived or title == name


# matches "1. Speak to Me", "01) Foo", "12 - Bar", " 12: Baz"
_TRACK_LINE_RE = re.compile(r"^\s*(\d{1,3})\s*[.\)\-:]\s+(.+?)\s*$")
# strip trailing duration markers like "(5:32)", " - 5:32", "  5:32"
_TRAILING_TIME_RE = re.compile(r"\s*[-(\[]?\s*\d{1,2}:\d{2}(?::\d{2})?\s*[)\]]?\s*$")
# common sidecar tracklist filenames (lowercase basename match)
_SIDECAR_NAMES = ("info.txt", "tracks.txt", "tracklist.txt", "setlist.txt", "notes.txt", "readme.txt")


def _clean_title(s: str) -> str:
    s = _TRAILING_TIME_RE.sub("", s).strip()
    # collapse whitespace
    return re.sub(r"\s+", " ", s)


def parse_tracklist_text(text: str) -> dict[int, str]:
    """Extract {track_num: title} from numbered lines in plain text or HTML."""
    if not text:
        return {}
    # strip common HTML tags but keep <li>/<br> as line breaks
    cleaned = re.sub(r"</?\s*(?:li|p|div|tr|br)[^>]*>", "\n", text, flags=re.I)
    cleaned = re.sub(r"<[^>]+>", "", cleaned)
    cleaned = (cleaned
               .replace("&amp;", "&")
               .replace("&lt;", "<")
               .replace("&gt;", ">")
               .replace("&quot;", '"')
               .replace("&#39;", "'")
               .replace("&nbsp;", " "))
    titles: dict[int, str] = {}
    for line in cleaned.splitlines():
        m = _TRACK_LINE_RE.match(line)
        if not m:
            continue
        n = int(m.group(1))
        title = _clean_title(m.group(2))
        if 1 <= n <= 200 and 1 <= len(title) <= 200 and not title.isdigit():
            titles[n] = title
    return titles


def parse_html_ol_tracklist(html: str) -> dict[int, str]:
    """Pull <ol><li>Speak to Me</li>... → {1: 'Speak to Me', ...} keeping order."""
    if not html or "<li" not in html.lower():
        return {}
    # Grab the contents of the first <ol>...</ol>; if absent, fall through to <li> scan.
    ol_match = re.search(r"<ol[^>]*>(.*?)</ol>", html, flags=re.I | re.S)
    scope = ol_match.group(1) if ol_match else html
    items = re.findall(r"<li[^>]*>(.*?)</li>", scope, flags=re.I | re.S)
    titles: dict[int, str] = {}
    for i, raw in enumerate(items, start=1):
        # strip any inner HTML tags
        text = re.sub(r"<[^>]+>", "", raw).strip()
        text = (text
                .replace("&amp;", "&")
                .replace("&nbsp;", " ")
                .replace("&#39;", "'"))
        text = _clean_title(text)
        if 1 <= len(text) <= 200:
            titles[i] = text
    return titles


async def _fetch_sidecar_tracklist(
    client: httpx.AsyncClient, identifier: str, files: list[dict[str, Any]]
) -> dict[int, str]:
    """Find an Info.txt / tracks.txt / etc. in the item and parse it."""
    candidates: list[tuple[int, str]] = []
    for f in files:
        name = f.get("name", "")
        bn = name.rsplit("/", 1)[-1].lower()
        if bn in _SIDECAR_NAMES:
            candidates.append((_SIDECAR_NAMES.index(bn), name))
    if not candidates:
        return {}
    candidates.sort()
    name = candidates[0][1]
    url = DOWNLOAD_URL.format(identifier=identifier, filename=quote(name, safe="/"))
    try:
        r = await client.get(url, timeout=5.0)
        if r.status_code != 200 or len(r.content) > 200_000:
            return {}
        try:
            text = r.content.decode("utf-8")
        except UnicodeDecodeError:
            text = r.content.decode("latin-1", errors="replace")
    except httpx.HTTPError:
        return {}
    return parse_tracklist_text(text)


def pick_audio_files(files: list[dict[str, Any]], identifier: str) -> list[dict[str, Any]]:
    """Filter to the best-format audio files, sorted by track number.

    Strategy: group by base name (sans extension); for each base name pick
    the single best format available. This avoids returning the same track
    once per format (Flac + VBR MP3 + Ogg Vorbis = 3 entries for 1 song).
    """
    audio = [f for f in files if f.get("format") in AUDIO_FORMATS]
    if not audio:
        return []

    by_base: dict[str, dict[str, Any]] = {}
    for f in audio:
        name = f.get("name", "")
        base = name.rsplit(".", 1)[0]
        cur = by_base.get(base)
        if cur is None or _format_rank(f["format"]) < _format_rank(cur["format"]):
            by_base[base] = f

    picked = list(by_base.values())
    picked.sort(key=lambda f: (_track_index(f.get("track")), f.get("name", "")))

    out: list[dict[str, Any]] = []
    for f in picked:
        name = f.get("name", "")
        out.append({
            "name": name,
            "title": _track_title(f),
            "format": f.get("format", ""),
            "size": int(f["size"]) if f.get("size") else 0,
            "size_h": _human_size(int(f["size"])) if f.get("size") else "",
            "length": _format_length(f.get("length")),
            "track": f.get("track") or "",
            "url": DOWNLOAD_URL.format(
                identifier=identifier,
                filename=quote(name, safe="/"),
            ),
        })
    return out


def _track_index_int(track: dict[str, Any]) -> int | None:
    """Best-effort track number as int (handles '1', '1/13', '01-A', etc.)."""
    raw = str(track.get("track", "")).strip()
    if not raw:
        return None
    head = raw.split("/")[0].split("-")[0].strip()
    try:
        return int(head)
    except ValueError:
        return None


def _apply_titles(tracks: list[dict[str, Any]], titles_by_num: dict[int, str]) -> int:
    """Overwrite default-derived titles with parsed ones. Returns count applied."""
    if not titles_by_num:
        return 0
    applied = 0
    # First pass: match by reported track number.
    for t in tracks:
        if not _is_default_title(t):
            continue
        n = _track_index_int(t)
        if n and n in titles_by_num:
            t["title"] = titles_by_num[n]
            applied += 1
    # Second pass: if track-number metadata is missing across the board,
    # fall back to positional order (track[i] ← titles[i+1]).
    if applied == 0 and len(titles_by_num) >= len([t for t in tracks if _is_default_title(t)]):
        for i, t in enumerate(tracks, start=1):
            if not _is_default_title(t):
                continue
            if i in titles_by_num:
                t["title"] = titles_by_num[i]
                applied += 1
    return applied


async def get_item(client: httpx.AsyncClient, identifier: str) -> dict[str, Any]:
    """Fetch metadata + filtered/sorted track list for an item."""
    url = METADATA_URL.format(identifier=identifier)
    r = await client.get(url, timeout=20.0)
    r.raise_for_status()
    data = r.json()

    meta = data.get("metadata", {}) or {}
    files = data.get("files", []) or []
    tracks = pick_audio_files(files, identifier)

    title = meta.get("title", "")
    if isinstance(title, list):
        title = " / ".join(title)
    desc = meta.get("description", "")
    if isinstance(desc, list):
        desc = " ".join(desc)
    creator = meta.get("creator", "")
    if isinstance(creator, list):
        creator = ", ".join(creator)
    date = meta.get("date", "") or ""
    if "T" in date:
        date = date.split("T", 1)[0]

    # Enrich track titles when archive.org didn't fill them in.
    if tracks and any(_is_default_title(t) for t in tracks):
        # 1. Try the description's <ol><li> tracklist
        titles = parse_html_ol_tracklist(desc)
        # 2. Try numbered lines anywhere in the description
        if not titles:
            titles = parse_tracklist_text(desc)
        # 3. Fall back to a sidecar Info.txt-style file
        if not titles:
            titles = await _fetch_sidecar_tracklist(client, identifier, files)
        if titles:
            _apply_titles(tracks, titles)

    return {
        "identifier": identifier,
        "title": title,
        "creator": creator,
        "date": date,
        "description": desc,
        "tracks": tracks,
    }
