"""Crawler tests against a local aiohttp server. Hostnames are mapped to the loopback test
server by an injected resolver; the SSRF tests use the real public-only resolver."""

from __future__ import annotations

import json
import socket
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field, replace
from typing import Any

import pytest
from aiohttp import web
from aiohttp.abc import AbstractResolver, ResolveResult
from aiohttp.test_utils import TestServer

from research_worker.adapters import AdapterFailure
from research_worker.adapters.base import set_progress_reporter
from research_worker.adapters.company_site import CompanySiteAdapter, CrawlerSettings
from research_worker.models import AdapterRequest
from research_worker.net import PublicOnlyResolver

from .test_adapters import assert_contract
from .test_net import fake_gai

UA = "MapforceBot/0.1 (+https://example.invalid/bot)"

ORG_JSON_LD = json.dumps(
    {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "WebSite", "name": "Acme"},
            {
                "@type": "Organization",
                "name": "Acme",
                "legalName": "Acme Example Ltd",
                "description": "Synthetic freight software company.",
                "address": {"@type": "PostalAddress", "addressCountry": "gb"},
            },
        ],
    }
)


def html_page(title: str, body: str, head: str = "") -> str:
    return f"<html lang='en'><head><title>{title}</title>{head}</head><body>{body}</body></html>"


HOME = html_page(
    "Acme | Home",
    """
    <h1>Acme</h1><p>We build synthetic freight software.</p>
    <a href="/about">About us</a>
    <a href="/private/team">Team</a>
    <a href="https://other.example/about">Partner</a>
    <a href="/contact?ref=nav#top">Contact</a>
    <a href="/brochure.pdf">Brochure about us</a>
    <a href="mailto:hello@acme.example">Email</a>
    <a href="/blog/random-post">Blog</a>
    """,
    head=(
        "<meta name='description' content='Acme builds synthetic freight software.'>"
        "<meta property='og:site_name' content='Acme Freight'>"
        f"<script type='application/ld+json'>{ORG_JSON_LD}</script>"
    ),
)


@dataclass
class Site:
    robots: tuple[int, str] = (200, "User-agent: *\nDisallow: /private\n")
    pages: dict[str, web.StreamResponse | Callable[[], web.StreamResponse]] = field(
        default_factory=dict
    )
    requests: list[tuple[str, str, dict[str, str]]] = field(default_factory=list)


class MapResolver(AbstractResolver):
    """Maps every hostname to the loopback test server."""

    async def resolve(
        self, host: str, port: int = 0, family: socket.AddressFamily = socket.AF_INET
    ) -> list[ResolveResult]:
        return [
            {
                "hostname": host,
                "host": "127.0.0.1",
                "port": port,
                "family": socket.AF_INET,
                "proto": 0,
                "flags": socket.AI_NUMERICHOST,
            }
        ]

    async def close(self) -> None:
        return None


@pytest.fixture
async def site() -> AsyncIterator[tuple[Site, TestServer]]:
    state = Site()

    async def handler(request: web.Request) -> web.StreamResponse:
        state.requests.append((request.host.split(":")[0], request.path_qs, dict(request.headers)))
        if request.path == "/robots.txt":
            status, text = state.robots
            return web.Response(status=status, text=text)
        page = state.pages.get(request.path)
        if page is None:
            return web.Response(status=404, text="not found")
        return page() if callable(page) else page

    app = web.Application()
    app.router.add_route("GET", "/{tail:.*}", handler)
    server = TestServer(app, host="127.0.0.1")
    await server.start_server()
    yield state, server
    await server.close()


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def adapter(
    server: TestServer, clock: FakeClock | None = None, **overrides: Any
) -> CompanySiteAdapter:
    settings = CrawlerSettings(
        user_agent=UA,
        min_delay_seconds=0.0,
        allowed_ports=(server.port or 0,),
        schemes=("http",),
        base_port=server.port,
    )
    clock = clock or FakeClock()
    return CompanySiteAdapter(
        replace(settings, **overrides),
        resolver_factory=MapResolver,
        sleep=clock.sleep,
        clock=clock,
    )


def req(domain: str = "acme.example", max_evidence: int = 8) -> AdapterRequest:
    return {
        "source_key": "company_site",
        "operation": "fetch_company_evidence",
        "company": {"domain": domain, "name": "Acme"},
        "budget": {"max_records": 25, "max_evidence": max_evidence},
        "correlation_id": "t",
    }


def html(body: str, **kwargs: Any) -> Callable[[], web.Response]:
    return lambda: web.Response(text=body, content_type="text/html", **kwargs)


def redirect(location: str) -> Callable[[], web.StreamResponse]:
    def respond() -> web.StreamResponse:
        raise web.HTTPFound(location)

    return respond


async def test_crawls_bounded_on_site_pages_and_extracts_declared_facts(
    site: tuple[Site, TestServer],
) -> None:
    state, server = site
    state.pages = {
        "/": lambda: web.Response(
            text=HOME, content_type="text/html", headers={"Set-Cookie": "sid=tracking"}
        ),
        "/about": html(html_page("About", "<p>About Acme.</p>")),
        "/contact": html(html_page("Contact", "<p>Contact page.</p>")),
        "/private/team": html(html_page("Team", "<p>Hidden.</p>")),
    }
    result = await adapter(server).run(req())
    assert_contract(result)
    urls = [e["source_url"] for e in result["evidence"]]
    port = server.port
    assert urls == [
        f"http://acme.example:{port}/",
        f"http://acme.example:{port}/about",
        f"http://acme.example:{port}/contact",
    ]
    paths = [path for _h, path, _hd in state.requests]
    assert "/private/team" not in paths, "robots.txt Disallow must be honoured"
    assert not any("other.example" == h for h, _p, _hd in state.requests)
    assert all(hd.get("User-Agent") == UA for _h, _p, hd in state.requests)
    assert all("Cookie" not in hd for _h, _p, hd in state.requests), "no cookies are kept"

    claims = {(c["predicate"], c["value"]): c for c in result["company_claims"]}
    assert claims[("canonical_name", "Acme Example Ltd")]["evidence_refs"] == ["ev-p0"]
    assert ("alias", "Acme") in claims
    assert ("country_code", "GB") in claims
    assert ("description", "Synthetic freight software company.") in claims
    assert all(c["claim_type"] == "source_fact" for c in result["company_claims"])
    assert result["usage"]["unit_type"] == "pages"
    assert result["usage"]["units"] == 3


async def test_robots_disallow_all_stops_before_home_page(site: tuple[Site, TestServer]) -> None:
    state, server = site
    state.robots = (200, "User-agent: MapforceBot\nDisallow: /\n")
    state.pages = {"/": html(HOME)}
    with pytest.raises(AdapterFailure) as exc:
        await adapter(server).run(req())
    assert exc.value.code == "ROBOTS_DISALLOWED"
    assert exc.value.retryable is False
    assert [p for _h, p, _hd in state.requests] == ["/robots.txt"]


@pytest.mark.parametrize(
    ("status", "outcome"), [(503, "ROBOTS_UNAVAILABLE"), (404, None), (403, "ROBOTS_DISALLOWED")]
)
async def test_robots_status_handling(
    site: tuple[Site, TestServer], status: int, outcome: str | None
) -> None:
    state, server = site
    state.robots = (status, "")
    state.pages = {"/": html(HOME)}
    if outcome is None:
        result = await adapter(server).run(req())
        assert len(result["evidence"]) >= 1
    else:
        with pytest.raises(AdapterFailure) as exc:
            await adapter(server).run(req())
        assert exc.value.code == outcome


async def test_crawl_delay_is_honoured(site: tuple[Site, TestServer]) -> None:
    state, server = site
    state.robots = (200, "User-agent: *\nCrawl-delay: 5\n")
    state.pages = {"/": html(HOME), "/about": html(html_page("About", "x"))}
    clock = FakeClock()
    await adapter(server, clock, time_budget_seconds=100).run(req())
    assert clock.sleeps and min(clock.sleeps) >= 5


async def test_long_crawl_delay_keeps_heartbeating(site: tuple[Site, TestServer]) -> None:
    state, server = site
    state.robots = (200, "User-agent: *\nCrawl-delay: 12\n")
    state.pages = {"/": html(HOME), "/about": html(html_page("About", "x"))}
    clock = FakeClock()
    progress: list[dict[str, Any]] = []
    set_progress_reporter(progress.append)
    try:
        await adapter(server, clock, time_budget_seconds=100).run(req())
    finally:
        set_progress_reporter(None)
    assert max(clock.sleeps) <= 5
    assert sum(clock.sleeps) >= 12
    assert sum(1 for p in progress if "waiting_seconds" in p) >= 3


async def test_time_budget_limits_pages(site: tuple[Site, TestServer]) -> None:
    state, server = site
    state.robots = (200, "User-agent: *\nCrawl-delay: 20\n")
    state.pages = {"/": html(HOME), "/about": html(html_page("About", "x"))}
    result = await adapter(server, time_budget_seconds=38).run(req())
    assert len(result["evidence"]) == 1, "no further page fits a 20 s delay in the budget"


async def test_page_and_budget_caps(site: tuple[Site, TestServer]) -> None:
    state, server = site
    links = "".join(f"<a href='/about/{i}'>About {i}</a>" for i in range(30))
    state.pages = {"/": html(html_page("Home", links + "x" * 5000))}
    for i in range(30):
        state.pages[f"/about/{i}"] = html(html_page("About", "y"))
    result = await adapter(server, max_page_bytes=2000).run(req(max_evidence=3))
    assert len(result["evidence"]) == 3
    assert result["evidence"][0]["normalized_content"]["truncated"] is True


async def test_off_site_redirect_is_blocked(site: tuple[Site, TestServer]) -> None:
    state, server = site
    state.pages = {"/": redirect("http://evil.example/")}
    with pytest.raises(AdapterFailure) as exc:
        await adapter(server).run(req())
    assert exc.value.code == "URL_BLOCKED"
    assert not any(h == "evil.example" for h, _p, _hd in state.requests)


async def test_redirect_loops_are_bounded(site: tuple[Site, TestServer]) -> None:
    state, server = site
    state.pages = {
        "/": redirect("/a"),
        "/a": redirect("/b"),
        "/b": redirect("/c"),
        "/c": redirect("/d"),
        "/d": html(HOME),
    }
    with pytest.raises(AdapterFailure) as exc:
        await adapter(server).run(req())
    assert exc.value.code == "URL_BLOCKED"
    assert "/d" not in [p for _h, p, _hd in state.requests]


async def test_www_redirect_uses_that_hosts_robots(site: tuple[Site, TestServer]) -> None:
    state, server = site
    port = server.port

    def home() -> web.StreamResponse:
        last_host = state.requests[-1][0]
        if last_host == "acme.example":
            raise web.HTTPMovedPermanently(f"http://www.acme.example:{port}/")
        return web.Response(text=HOME, content_type="text/html")

    state.pages = {"/": home, "/about": html(html_page("About", "x"))}
    result = await adapter(server).run(req())
    hosts_for_robots = [h for h, p, _hd in state.requests if p == "/robots.txt"]
    assert hosts_for_robots == ["acme.example", "www.acme.example"]
    assert result["evidence"][0]["source_url"] == f"http://www.acme.example:{port}/"


async def test_non_html_home_page_is_rejected(site: tuple[Site, TestServer]) -> None:
    state, server = site
    state.pages = {"/": lambda: web.json_response({"a": 1})}
    with pytest.raises(AdapterFailure) as exc:
        await adapter(server).run(req())
    assert exc.value.code == "UNSUPPORTED_CONTENT"


async def test_private_address_resolution_is_blocked(site: tuple[Site, TestServer]) -> None:
    _state, server = site
    a = adapter(server)
    a._resolver_factory = lambda: PublicOnlyResolver(fake_gai("127.0.0.1"))
    with pytest.raises(AdapterFailure) as exc:
        await a.run(req())
    assert exc.value.code == "URL_BLOCKED"
    assert exc.value.retryable is False


async def test_metadata_address_is_blocked(site: tuple[Site, TestServer]) -> None:
    _state, server = site
    a = adapter(server)
    a._resolver_factory = lambda: PublicOnlyResolver(fake_gai("169.254.169.254"))
    with pytest.raises(AdapterFailure) as exc:
        await a.run(req("metadata.example"))
    assert exc.value.code == "URL_BLOCKED"


@pytest.mark.parametrize("domain", ["127.0.0.1", "localhost", "acme.example/path", "a b.example"])
async def test_invalid_domains_are_rejected(site: tuple[Site, TestServer], domain: str) -> None:
    _state, server = site
    with pytest.raises(AdapterFailure) as exc:
        await adapter(server).run(req(domain))
    assert exc.value.code == "INVALID_REQUEST"
