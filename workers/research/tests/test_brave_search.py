"""Brave adapter tests against a local fake endpoint with a synthetic fixture (no real data)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from research_worker.adapters import AdapterFailure
from research_worker.adapters.brave_search import BraveSearchAdapter
from research_worker.models import AdapterRequest

from .test_adapters import assert_contract

KEY = "test-placeholder-key"
FIXTURE: dict[str, Any] = {
    "type": "search",
    "web": {
        "results": [
            {
                "title": "Acme Logistics | Freight software for shippers",
                "url": "https://www.acme-logistics.example/",
                "description": (
                    "<strong>Acme</strong> Logistics builds freight &amp; routing tools."
                ),
            },
            {
                "title": "Acme Logistics - About",
                "url": "https://acme-logistics.example/about",
                "description": "Duplicate domain.",
            },
            {
                "title": "Acme Logistics | LinkedIn",
                "url": "https://www.linkedin.com/company/acme-logistics-example",
                "description": "Social profile.",
            },
            {"title": "Raw IP", "url": "http://203.0.113.7/", "description": "IP host."},
            {
                "title": "Northwind Freight — Mid-market shipping",
                "url": "https://northwind-freight.example/en",
                "description": None,
            },
            {"title": "Missing url"},
        ]
    },
}


@dataclass
class Endpoint:
    status: int = 200
    body: str = json.dumps(FIXTURE)
    seen: list[web.Request] = field(default_factory=list)


@pytest.fixture
async def endpoint() -> AsyncIterator[tuple[Endpoint, str]]:
    state = Endpoint()

    async def handler(request: web.Request) -> web.Response:
        state.seen.append(request)
        return web.Response(status=state.status, text=state.body, content_type="application/json")

    app = web.Application()
    app.router.add_get("/res/v1/web/search", handler)
    server = TestServer(app, host="127.0.0.1")
    await server.start_server()
    yield state, f"http://127.0.0.1:{server.port}/res/v1/web/search"
    await server.close()


def req(countries: list[str] | None = None, max_records: int = 25) -> AdapterRequest:
    return {
        "source_key": "brave_search",
        "operation": "discover_companies",
        "query": {"text": "freight software", "country_codes": countries or ["GB"]},
        "budget": {"max_records": max_records, "max_evidence": 10},
        "correlation_id": "t",
    }


async def test_maps_results_to_reviewable_candidates(endpoint: tuple[Endpoint, str]) -> None:
    state, url = endpoint
    result = await BraveSearchAdapter(KEY, endpoint=url).run(req())
    assert_contract(result)
    companies = result.get("companies", [])
    assert [c["domain"] for c in companies] == [
        "acme-logistics.example",
        "northwind-freight.example",
    ]
    assert companies[0]["name"] == "Acme Logistics"
    assert companies[0]["description"] == "Acme Logistics builds freight & routing tools."
    assert companies[1]["name"] == "Northwind Freight"
    assert all(c["claim_type"] == "provider_fact" and c["confidence"] < 0.5 for c in companies)
    assert all(c["country_code"] is None for c in companies), "country is not inferred"

    sent = state.seen[0]
    assert sent.headers["X-Subscription-Token"] == KEY
    assert sent.query["country"] == "GB"
    assert sent.query["safesearch"] == "strict"
    assert KEY not in json.dumps(result), "the API key must never reach evidence"


async def test_multi_country_queries_search_all_and_budget_caps(
    endpoint: tuple[Endpoint, str],
) -> None:
    state, url = endpoint
    result = await BraveSearchAdapter(KEY, endpoint=url).run(req(["GB", "DE"], max_records=1))
    assert state.seen[0].query["country"] == "ALL"
    assert len(result.get("companies", [])) == 1


@pytest.mark.parametrize(
    ("status", "body", "code", "retryable"),
    [
        (401, "{}", "SOURCE_AUTH_FAILED", False),
        (429, "{}", "RATE_LIMITED", True),
        (503, "{}", "SOURCE_UNAVAILABLE", True),
        (422, "{}", "PROVIDER_REQUEST_REJECTED", False),
        (200, "not json", "PROVIDER_RESPONSE_INVALID", False),
        (200, json.dumps({"web": {"results": "nope"}}), "PROVIDER_RESPONSE_INVALID", False),
    ],
)
async def test_failures_map_to_stable_codes(
    endpoint: tuple[Endpoint, str], status: int, body: str, code: str, retryable: bool
) -> None:
    state, url = endpoint
    state.status, state.body = status, body
    with pytest.raises(AdapterFailure) as exc:
        await BraveSearchAdapter(KEY, endpoint=url).run(req())
    assert (exc.value.code, exc.value.retryable) == (code, retryable)


async def test_unreachable_endpoint_is_retryable() -> None:
    adapter = BraveSearchAdapter(KEY, endpoint="http://127.0.0.1:1/res/v1/web/search", timeout=2)
    with pytest.raises(AdapterFailure) as exc:
        await adapter.run(req())
    assert exc.value.code == "SOURCE_UNAVAILABLE"
    assert exc.value.retryable is True


def test_requires_a_key() -> None:
    with pytest.raises(ValueError, match="api_key"):
        BraveSearchAdapter("")
