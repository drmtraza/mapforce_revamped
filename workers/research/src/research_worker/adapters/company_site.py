"""Polite, bounded crawler for a company's own public website.

Guarantees: robots.txt is fetched first and honoured for every URL (including redirect
targets) together with Crawl-delay/Request-rate; requests carry an identifying user agent;
only the company's domain (and its subdomains) on allowed ports is fetched, through the
SSRF-guarded resolver; redirects, pages, bytes per page and wall-clock time are capped.
No cookies, credentials, JavaScript execution or anti-bot evasion.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.robotparser import RobotFileParser

import aiohttp
from aiohttp.abc import AbstractResolver
from yarl import URL

from ..extract import Page, parse_html
from ..models import AdapterRequest, AdapterResult, CompanyClaim, Evidence, Operation, empty_result
from ..net import BlockedAddressError, PublicOnlyResolver, check_url, is_hostname
from .base import AdapterFailure, BaseAdapter, report_progress, require_company

HTML_TYPES = frozenset({"text/html", "application/xhtml+xml"})
REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
HEARTBEAT_SLICE_SECONDS = 5.0
PRIORITY_KEYWORDS = (
    "about",
    "company",
    "who-we-are",
    "leadership",
    "management",
    "team",
    "contact",
    "careers",
    "jobs",
    "news",
    "press",
)
SKIP_EXTENSIONS = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".zip", ".mp4", ".css", ".js")


@dataclass(frozen=True)
class CrawlerSettings:
    user_agent: str
    max_pages: int = 8
    max_page_bytes: int = 1_000_000
    max_robots_bytes: int = 500_000
    max_redirects: int = 3
    min_delay_seconds: float = 1.0
    time_budget_seconds: float = 38.0
    request_timeout_seconds: float = 10.0
    allowed_ports: tuple[int, ...] = (80, 443)
    schemes: tuple[str, ...] = ("https", "http")
    base_port: int | None = None


@dataclass
class _Response:
    url: URL
    status: int
    content_type: str
    charset: str | None
    body: bytes
    truncated: bool


class _Blocked(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _link_score(url: URL) -> int:
    path = url.path.lower()
    for i, keyword in enumerate(PRIORITY_KEYWORDS):
        if keyword in path:
            return len(PRIORITY_KEYWORDS) - i
    return 0


class CompanySiteAdapter(BaseAdapter):
    source_key = "company_site"
    provider = "company_website"
    operations: frozenset[Operation] = frozenset({"fetch_company_evidence"})

    def __init__(
        self,
        settings: CrawlerSettings,
        resolver_factory: Callable[[], AbstractResolver] = PublicOnlyResolver,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.settings = settings
        self._resolver_factory = resolver_factory
        self._sleep = sleep
        self._clock = clock

    async def fetch_company_evidence(self, request: AdapterRequest) -> AdapterResult:
        domain = require_company(request)["domain"].lower().strip().rstrip(".")
        if domain.startswith("www."):
            domain = domain[4:]
        if not is_hostname(domain):
            raise AdapterFailure(
                "INVALID_REQUEST", "Company domain is not a hostname", retryable=False
            )
        max_pages = max(0, min(self.settings.max_pages, request["budget"]["max_evidence"]))
        result = empty_result(self.source_key, self.provider, "fetch_company_evidence")
        if max_pages == 0:
            return result

        s = self.settings
        connector = aiohttp.TCPConnector(
            resolver=self._resolver_factory(), use_dns_cache=False, limit_per_host=1
        )
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=aiohttp.ClientTimeout(total=s.request_timeout_seconds, connect=5),
            headers={"User-Agent": s.user_agent, "Accept": "text/html,application/xhtml+xml"},
            cookie_jar=aiohttp.DummyCookieJar(),
            trust_env=False,
        ) as session:
            crawl = _Crawl(self, session, domain, max_pages)
            return await crawl.run(result)


class _Crawl:
    def __init__(
        self, adapter: CompanySiteAdapter, session: aiohttp.ClientSession, domain: str, pages: int
    ) -> None:
        self.a = adapter
        self.s = adapter.settings
        self.session = session
        self.domain = domain
        self.max_pages = pages
        self.started = adapter._clock()
        self.last_request: float | None = None
        self.delay = self.s.min_delay_seconds
        self.requests = 0
        self.robots = RobotFileParser()

    # -- HTTP ---------------------------------------------------------------------------
    def _time_left(self) -> float:
        return self.s.time_budget_seconds - (self.a._clock() - self.started)

    async def _throttle(self) -> None:
        if self.last_request is not None:
            # Sleep in short slices so heartbeats keep flowing during long Crawl-delays.
            while (wait := self.last_request + self.delay - self.a._clock()) > 0:
                await self.a._sleep(min(wait, HEARTBEAT_SLICE_SECONDS))
                report_progress(waiting_seconds=round(max(wait - HEARTBEAT_SLICE_SECONDS, 0), 1))
        self.last_request = self.a._clock()

    async def _get(self, url: URL, max_bytes: int, *, robots_check: bool) -> _Response:
        for _hop in range(self.s.max_redirects + 1):
            reason = check_url(url, self.domain, self.s.allowed_ports)
            if reason:
                raise _Blocked(reason)
            if robots_check and not self.robots.can_fetch(self.s.user_agent, str(url)):
                raise _Blocked("robots")
            await self._throttle()
            self.requests += 1
            report_progress(url=str(url), requests=self.requests)
            async with self.session.get(url, allow_redirects=False) as resp:
                if resp.status in REDIRECT_CODES:
                    location = resp.headers.get("Location")
                    if not location:
                        raise _Blocked("redirect_without_location")
                    url = url.join(URL(location)).with_fragment(None)
                    continue
                body = bytearray()
                truncated = False
                async for chunk in resp.content.iter_chunked(65_536):
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        del body[max_bytes:]
                        truncated = True
                        break
                return _Response(
                    url=url,
                    status=resp.status,
                    content_type=resp.content_type.lower(),
                    charset=resp.charset,
                    body=bytes(body),
                    truncated=truncated,
                )
        raise _Blocked("too_many_redirects")

    # -- robots.txt -----------------------------------------------------------------------
    async def _load_robots(self, base: URL) -> None:
        resp = await self._get(
            base.with_path("/robots.txt"), self.s.max_robots_bytes, robots_check=False
        )
        if resp.status == 200:
            self.robots.parse(resp.body.decode("utf-8", "replace").splitlines())
        elif resp.status in (401, 403):
            self.robots.parse(["User-agent: *", "Disallow: /"])
        elif resp.status == 429 or resp.status >= 500:
            raise AdapterFailure(
                "ROBOTS_UNAVAILABLE", f"robots.txt returned HTTP {resp.status}", retryable=True
            )
        else:
            self.robots.parse([])
        crawl_delay = self.robots.crawl_delay(self.s.user_agent)
        rate = self.robots.request_rate(self.s.user_agent)
        if crawl_delay is not None:
            self.delay = max(self.delay, float(crawl_delay))
        if rate is not None and rate.requests > 0:
            self.delay = max(self.delay, rate.seconds / rate.requests)

    async def _start(self) -> tuple[URL, _Response]:
        last_error: Exception | None = None
        for scheme in self.s.schemes:
            base = URL.build(scheme=scheme, host=self.domain, port=self.s.base_port)
            try:
                await self._load_robots(base)
                home = await self._get(
                    base.with_path("/"), self.s.max_page_bytes, robots_check=True
                )
                if home.url.host != base.host:
                    self.robots = RobotFileParser()
                    await self._load_robots(home.url.with_path("/").with_query(None))
                    if not self.robots.can_fetch(self.s.user_agent, str(home.url)):
                        raise _Blocked("robots")
                return base, home
            except aiohttp.ClientConnectorError as err:
                if _is_blocked(err):
                    raise AdapterFailure(
                        "URL_BLOCKED", "Site resolves to a non-public address", retryable=False
                    ) from err
                last_error = err
            except (aiohttp.ClientError, TimeoutError) as err:
                last_error = err
        raise AdapterFailure(
            "SOURCE_UNAVAILABLE", "Company website is unreachable", retryable=True
        ) from last_error

    # -- crawl ----------------------------------------------------------------------------
    async def run(self, result: AdapterResult) -> AdapterResult:
        try:
            base, home = await self._start()
        except _Blocked as err:
            if err.reason == "robots":
                raise AdapterFailure(
                    "ROBOTS_DISALLOWED", "robots.txt disallows the home page", retryable=False
                ) from err
            raise AdapterFailure(
                "URL_BLOCKED", f"Home page blocked by URL policy ({err.reason})", retryable=False
            ) from err
        if home.status == 429 or home.status >= 500:
            raise AdapterFailure(
                "SOURCE_UNAVAILABLE", f"Home page returned HTTP {home.status}", retryable=True
            )
        if home.status != 200:
            raise AdapterFailure(
                "SITE_NOT_ACCESSIBLE", f"Home page returned HTTP {home.status}", retryable=False
            )
        if home.content_type not in HTML_TYPES:
            raise AdapterFailure("UNSUPPORTED_CONTENT", "Home page is not HTML", retryable=False)

        pages: list[tuple[_Response, Page]] = [(home, self._parse(home))]
        seen = {str(home.url.with_query(None)), str(base.with_path("/"))}
        for target in self._candidate_links(home.url, pages[0][1]):
            if len(pages) >= self.max_pages:
                break
            if self._time_left() < self.delay + self.s.request_timeout_seconds:
                break
            if str(target) in seen:
                continue
            seen.add(str(target))
            try:
                resp = await self._get(target, self.s.max_page_bytes, robots_check=True)
            except (_Blocked, aiohttp.ClientError, TimeoutError):
                continue
            if resp.status == 200 and resp.content_type in HTML_TYPES:
                pages.append((resp, self._parse(resp)))

        evidence = [self._evidence(i, resp, page) for i, (resp, page) in enumerate(pages)]
        result["evidence"] = evidence
        result["company_claims"] = self._claims(pages)
        result["usage"] = {
            "request_count": self.requests,
            "units": len(pages),
            "unit_type": "pages",
        }
        return result

    def _parse(self, resp: _Response) -> Page:
        try:
            html = resp.body.decode(resp.charset or "utf-8", "replace")
        except LookupError:
            html = resp.body.decode("utf-8", "replace")
        return parse_html(html)

    def _candidate_links(self, page_url: URL, page: Page) -> list[URL]:
        scored: dict[str, tuple[int, URL]] = {}
        for href in page.links:
            if href.startswith(("mailto:", "tel:", "javascript:", "#")):
                continue
            try:
                url = page_url.join(URL(href)).with_fragment(None).with_query(None)
            except ValueError:
                continue
            if url.path.lower().endswith(SKIP_EXTENSIONS):
                continue
            if url.host != page_url.host or check_url(url, self.domain, self.s.allowed_ports):
                continue
            score = _link_score(url)
            if score:
                scored.setdefault(str(url), (score, url))
        ordered = sorted(scored.values(), key=lambda item: (-item[0], str(item[1])))
        return [url for _score, url in ordered]

    def _evidence(self, index: int, resp: _Response, page: Page) -> Evidence:
        content: dict[str, Any] = {
            "title": page.title,
            "meta_description": page.meta.get("description"),
            "lang": page.lang,
            "canonical": page.canonical,
            "text": page.text[:20_000],
            "truncated": resp.truncated,
        }
        if page.organization:
            content["json_ld_organization"] = vars(page.organization)
        excerpt = page.meta.get("description") or page.text or (page.title or "")
        return {
            "ref": f"ev-p{index}",
            "source_url": str(resp.url),
            "fetched_at": _now(),
            "published_at": None,
            "content_type": "text/html",
            "content_hash": "sha256:" + hashlib.sha256(resp.body).hexdigest(),
            "excerpt": excerpt[:2000],
            "normalized_content": content,
            "license_metadata": {
                "terms": "public web page",
                "robots_txt": "allowed",
                "user_agent": self.s.user_agent,
            },
        }

    def _claims(self, pages: list[tuple[_Response, Page]]) -> list[CompanyClaim]:
        claims: list[CompanyClaim] = []

        def add(predicate: str, value: str | None, confidence: float, index: int) -> None:
            if value and not any(
                c["predicate"] == predicate and c["value"] == value for c in claims
            ):
                claims.append(
                    {
                        "predicate": predicate,
                        "value": value[:1000],
                        "claim_type": "source_fact",
                        "confidence": confidence,
                        "evidence_refs": [f"ev-p{index}"],
                    }
                )

        org_index = next((i for i, (_r, p) in enumerate(pages) if p.organization), None)
        home = pages[0][1]
        site_name = home.meta.get("og:site_name")
        if org_index is not None:
            org = pages[org_index][1].organization
            assert org is not None
            canonical = org.legal_name or org.name
            add("canonical_name", canonical, 0.85, org_index)
            if org.legal_name and org.name and org.name != org.legal_name:
                add("alias", org.name, 0.8, org_index)
            add("description", org.description, 0.75, org_index)
            add("country_code", org.country_code, 0.7, org_index)
            if site_name and site_name != canonical:
                add("alias", site_name, 0.5, 0)
        else:
            add("canonical_name", site_name, 0.6, 0)
        if not any(c["predicate"] == "description" for c in claims):
            add("description", home.meta.get("description"), 0.6, 0)
        return claims


def _is_blocked(err: BaseException) -> bool:
    chain: BaseException | None = err
    for _ in range(5):
        if chain is None:
            return False
        if isinstance(chain, BlockedAddressError):
            return True
        chain = getattr(chain, "os_error", None) or chain.__cause__
    return False
