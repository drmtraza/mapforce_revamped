"""Brave Search API adapter (owner decision D14): web search -> reviewable company candidates.

Registered only when `BRAVE_SEARCH_API_KEY` is configured; the source is also globally
disabled in `source_registry` until the owner has reviewed the provider terms. The key is
sent as a header and never logged or stored in evidence. Candidate names come from page
titles and are labelled provider facts with low confidence; they are reviewed by a person
before any company record is created.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
from datetime import UTC, datetime
from typing import Any

import aiohttp
from yarl import URL

from ..models import (
    AdapterRequest,
    AdapterResult,
    CompanyCandidate,
    Evidence,
    Operation,
    empty_result,
)
from ..net import is_hostname, is_ip_literal
from .base import AdapterFailure, BaseAdapter, require_query

DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
MAX_RESPONSE_BYTES = 2_000_000
MAX_RESULTS = 20
# Directories, social networks and media rarely identify the company itself.
NON_COMPANY_HOSTS = (
    "wikipedia.org",
    "linkedin.com",
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "crunchbase.com",
    "bloomberg.com",
    "glassdoor.com",
    "glassdoor.co.uk",
    "indeed.com",
    "zoominfo.com",
    "reddit.com",
    "medium.com",
    "github.com",
    "amazon.com",
    "yelp.com",
)
_TAGS = re.compile(r"<[^>]+>")
_TITLE_SPLIT = re.compile("\\s+[|\\-\u2013\u2014:\u00b7]\\s+")


def _strip(text: Any, limit: int) -> str | None:
    if not isinstance(text, str):
        return None
    clean = " ".join(html.unescape(_TAGS.sub("", text)).split())
    return clean[:limit] or None


def _domain(url: str) -> str | None:
    try:
        host = (URL(url).host or "").lower().rstrip(".")
    except ValueError:
        return None
    if host.startswith("www."):
        host = host[4:]
    if not host or is_ip_literal(host) or not is_hostname(host):
        return None
    if any(host == h or host.endswith("." + h) for h in NON_COMPANY_HOSTS):
        return None
    return host


def _name(title: str, domain: str) -> str:
    parts = [p.strip() for p in _TITLE_SPLIT.split(title) if p.strip()]
    label = domain.split(".")[0].replace("-", "")
    for part in parts:
        if label and label in part.lower().replace(" ", "").replace("-", ""):
            return part[:300]
    return (parts[-1] if len(parts) > 1 else parts[0] if parts else domain)[:300]


class BraveSearchAdapter(BaseAdapter):
    source_key = "brave_search"
    provider = "brave"
    operations: frozenset[Operation] = frozenset({"discover_companies"})

    def __init__(self, api_key: str, endpoint: str = DEFAULT_ENDPOINT, timeout: float = 10.0):
        if not api_key:
            raise ValueError("api_key is required")
        self._key = api_key
        self._endpoint = endpoint
        self._timeout = timeout

    async def discover_companies(self, request: AdapterRequest) -> AdapterResult:
        query = require_query(request)
        text = " ".join(query["text"].split())[:400]
        countries = query["country_codes"]
        params = {
            "q": text,
            "count": str(MAX_RESULTS),
            "safesearch": "strict",
            "country": countries[0] if len(countries) == 1 else "ALL",
            "result_filter": "web",
        }
        raw = await self._fetch(params)
        try:
            data = json.loads(raw)
            results = data.get("web", {}).get("results", []) if isinstance(data, dict) else None
        except (ValueError, AttributeError):
            results = None
        if not isinstance(results, list):
            raise AdapterFailure(
                "PROVIDER_RESPONSE_INVALID", "Unexpected Brave response shape", retryable=False
            )

        limit = min(request["budget"]["max_records"], 50)
        listing: list[dict[str, str | None]] = []
        candidates: list[CompanyCandidate] = []
        seen: set[str] = set()
        for item in results[:MAX_RESULTS]:
            if not isinstance(item, dict) or not isinstance(item.get("url"), str):
                continue
            domain = _domain(item["url"])
            title = _strip(item.get("title"), 300)
            description = _strip(item.get("description"), 1000)
            listing.append({"title": title, "url": item["url"][:2048], "description": description})
            if not domain or not title or domain in seen or len(candidates) >= limit:
                continue
            seen.add(domain)
            candidates.append(
                {
                    "ref": f"c{len(candidates)}",
                    "name": _name(title, domain),
                    "domain": domain,
                    "country_code": None,
                    "description": description,
                    "claim_type": "provider_fact",
                    "confidence": 0.4,
                    "evidence_refs": ["ev-search"],
                }
            )

        public_url = URL(self._endpoint).with_query({k: v for k, v in params.items()})
        evidence: Evidence = {
            "ref": "ev-search",
            "source_url": str(public_url)[:2048],
            "fetched_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "published_at": None,
            "content_type": "application/json",
            "content_hash": "sha256:" + hashlib.sha256(raw).hexdigest(),
            "excerpt": "; ".join(str(r["title"]) for r in listing if r["title"])[:2000],
            "normalized_content": {"query": text, "results": listing},
            "license_metadata": {"provider": "Brave Search API", "terms": "provider terms"},
        }
        result = empty_result(self.source_key, self.provider, "discover_companies")
        result["usage"] = {"request_count": 1, "units": 1, "unit_type": "queries"}
        result["evidence"] = [evidence]
        result["companies"] = candidates
        return result

    async def _fetch(self, params: dict[str, str]) -> bytes:
        headers = {
            "Accept": "application/json",
            "X-Subscription-Token": self._key,
        }
        try:
            async with (
                aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=self._timeout), trust_env=False
                ) as session,
                session.get(self._endpoint, params=params, headers=headers) as resp,
            ):
                if resp.status in (401, 403):
                    raise AdapterFailure(
                        "SOURCE_AUTH_FAILED", "Brave rejected the API key", retryable=False
                    )
                if resp.status == 429:
                    raise AdapterFailure("RATE_LIMITED", "Brave rate limit reached", retryable=True)
                if resp.status >= 500:
                    raise AdapterFailure(
                        "SOURCE_UNAVAILABLE", f"Brave returned HTTP {resp.status}", retryable=True
                    )
                if resp.status != 200:
                    raise AdapterFailure(
                        "PROVIDER_REQUEST_REJECTED",
                        f"Brave returned HTTP {resp.status}",
                        retryable=False,
                    )
                body = bytearray()
                async for chunk in resp.content.iter_chunked(65_536):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise AdapterFailure(
                            "PROVIDER_RESPONSE_INVALID", "Brave response too large", retryable=False
                        )
                return bytes(body)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise AdapterFailure(
                "SOURCE_UNAVAILABLE", "Brave Search is unreachable", retryable=True
            ) from err
