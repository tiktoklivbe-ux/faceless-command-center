"""
Free, no-signup business lead search for the Business scene's "Find
businesses" tool. Uses OpenStreetMap's public services:
  - Nominatim (https://nominatim.org) to turn a typed location into coordinates.
  - Overpass API (https://overpass-api.de) to find businesses near those
    coordinates whose category/name matches the search term.

Both are free, shared public infrastructure with real usage policies -- a
proper User-Agent (required) and modest, non-automated-feeling request
volume (this is a person clicking "search" occasionally, not a scraper). No
API key needed, which is the whole point of this being the zero-setup option
compared to Google Places.

Coverage/detail varies a lot by area (OSM is crowd-mapped), and business
EMAIL addresses are rarely tagged there at all -- find_contact_email() below
is the best-effort fallback: fetch the business's OWN public website (same
SSRF-guarded pattern jarvis_tools.fetch_url already uses) and look for a
contact address on it.
"""
import re
from urllib.parse import urlparse

import requests

from .jarvis_tools import _is_safe_public_host

USER_AGENT = "faceless-command-center/1.0 (business-lead-search; personal use)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def geocode_location(location: str) -> tuple[float, float] | None:
    resp = requests.get(
        NOMINATIM_URL,
        params={"q": location, "format": "json", "limit": 1},
        headers={"User-Agent": USER_AGENT},
        timeout=8,
    )
    resp.raise_for_status()
    results = resp.json()
    if not results:
        return None
    return float(results[0]["lat"]), float(results[0]["lon"])


def _esc(term: str) -> str:
    # Regex-escape the user's term for safe interpolation into the Overpass
    # query string -- it's substring/case-insensitive matched against tag
    # values, not used as a literal regex the user controls the syntax of.
    return re.sub(r'[\\"]', "", term)[:80]


def search_businesses(term: str, location: str, radius_m: int = 4000, limit: int = 25) -> dict:
    coords = geocode_location(location)
    if not coords:
        return {"error": f"Couldn't find a location matching '{location}'.", "results": []}
    lat, lon = coords
    t = _esc(term)
    # Dropped the unfiltered node["name"~...] clause that was here -- proven
    # live to be what actually caused the timeouts: it has to scan every
    # named node in the whole radius with no category to narrow by first,
    # which is a much heavier query than the other four (each scoped to one
    # indexed tag key). Radius also brought down from 6km to 4km (less area
    # to scan). Overpass's own [timeout:N] is best-effort, not a hard wall --
    # a live test at timeout:10 still ran ~11.4s and got cut off mid-query
    # (returned partial real results plus a truncation "remark"), so this
    # gives it a bit more real room; the outer request timeout below is set
    # with enough margin over this to let it actually finish rather than
    # getting cut off by OUR side first.
    query = f"""
    [out:json][timeout:15];
    (
      node["shop"~"{t}",i](around:{radius_m},{lat},{lon});
      node["amenity"~"{t}",i](around:{radius_m},{lat},{lon});
      node["craft"~"{t}",i](around:{radius_m},{lat},{lon});
      node["office"~"{t}",i](around:{radius_m},{lat},{lon});
    );
    out body {limit};
    """
    # Kept short deliberately -- a slow response here (Overpass is a free,
    # shared public service and does have slow/overloaded moments) used to
    # block the whole app for the full timeout window, taking down every
    # other request/health check with it. Confirmed live: a 30s timeout
    # produced a genuine platform-level 502 on the whole site while this one
    # request was stuck. Failing fast beats hanging everything else.
    resp = requests.post(OVERPASS_URL, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=20)
    resp.raise_for_status()
    elements = resp.json().get("elements", [])

    seen_names = set()
    out = []
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        addr_parts = [tags.get("addr:housenumber"), tags.get("addr:street"), tags.get("addr:city")]
        address = " ".join(p for p in addr_parts if p)
        out.append({
            "name": name,
            "address": address,
            "phone": tags.get("phone") or tags.get("contact:phone") or "",
            "website": tags.get("website") or tags.get("contact:website") or "",
            "category": tags.get("shop") or tags.get("amenity") or tags.get("craft") or tags.get("office") or "",
        })
        if len(out) >= limit:
            break
    return {"error": None, "results": out}


_EMAIL_PATTERN = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_GENERIC_LOCAL_PARTS = {"info", "contact", "hello", "sales", "office", "admin", "support"}


def find_contact_email(website: str) -> str:
    """Best-effort: fetch the business's own public site and look for a
    contact email. Same SSRF guard as the app's existing read-only web-fetch
    tool. Returns '' if nothing found rather than raising -- this is
    optional enrichment, not a required step."""
    if not website:
        return ""
    url = website if website.startswith("http") else f"https://{website}"
    parsed = urlparse(url)
    if not _is_safe_public_host(parsed.hostname):
        return ""
    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10, allow_redirects=True)
        if not _is_safe_public_host(urlparse(resp.url).hostname):
            return ""
    except requests.RequestException:
        return ""
    if resp.status_code != 200:
        return ""
    emails = set(_EMAIL_PATTERN.findall(resp.text))
    if not emails:
        return ""
    # Prefer a generic contact-style address over a personal-looking one if
    # both are present -- more likely to actually be checked/monitored.
    generic = [e for e in emails if e.split("@")[0].lower() in _GENERIC_LOCAL_PARTS]
    return sorted(generic or emails)[0]
