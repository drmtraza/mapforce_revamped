from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from research_worker.activities import ResearchActivities
from research_worker.adapters import AdapterFailure, build_registry
from research_worker.adapters.mock import MockPeopleAdapter, MockRegistryAdapter, MockWebAdapter
from research_worker.models import AdapterRequest, AdapterResult, Operation

SCHEMA_PATH = Path(__file__).resolve().parents[3] / "contracts" / "adapter-result.v1.schema.json"
VALIDATOR = Draft202012Validator(
    json.loads(SCHEMA_PATH.read_text(encoding="utf-8")), format_checker=FormatChecker()
)


def request(source_key: str, operation: Operation, domain: str = "acme.example") -> AdapterRequest:
    return {
        "source_key": source_key,
        "operation": operation,
        "company": {"domain": domain, "name": domain},
        "budget": {"max_records": 25, "max_evidence": 10},
        "correlation_id": "test-correlation",
    }


def assert_contract(result: AdapterResult) -> None:
    errors = sorted(VALIDATOR.iter_errors(result), key=lambda e: list(e.path))
    assert errors == [], [f"{list(e.path)}: {e.message}" for e in errors]
    refs = {e["ref"] for e in result["evidence"]}
    people = {p["ref"] for p in result["people"]}
    cited: list[str] = []
    for c in result["company_claims"]:
        cited += c["evidence_refs"]
    for p in result["people"]:
        cited += p["evidence_refs"]
    for r in result["relationships"]:
        cited += r["evidence_refs"]
        assert r["subject_ref"] in people and r["object_ref"] in people
    assert set(cited) <= refs, "every claim must cite evidence present in the payload"


def without_timestamps(result: AdapterResult) -> dict[str, Any]:
    clone: dict[str, Any] = json.loads(json.dumps(result))
    for e in clone["evidence"]:
        e.pop("fetched_at")
    return clone


@pytest.mark.parametrize(
    ("adapter", "operation"),
    [
        (MockWebAdapter(), "fetch_company_evidence"),
        (MockPeopleAdapter(), "discover_people"),
        (MockRegistryAdapter(), "fetch_registry_record"),
    ],
)
async def test_mock_output_satisfies_contract_and_is_deterministic(
    adapter: MockWebAdapter | MockPeopleAdapter | MockRegistryAdapter, operation: Operation
) -> None:
    for domain in ("acme.example", "globex.test", "initech.example"):
        first = await adapter.run(request(adapter.source_key, operation, domain))
        second = await adapter.run(request(adapter.source_key, operation, domain))
        assert_contract(first)
        assert without_timestamps(first) == without_timestamps(second)


async def test_people_relationships_are_labelled_honestly() -> None:
    result = await MockPeopleAdapter().run(request("mock_people", "discover_people"))
    by_predicate = {r["predicate"]: r for r in result["relationships"]}
    assert by_predicate["REPORTS_TO"]["status"] == "verified"
    excerpt = result["evidence"][0]["excerpt"]
    assert "reports to" in excerpt, "a verified reporting line must be stated in the evidence"
    assert by_predicate["INFLUENCES"]["status"] == "inferred"
    assert "not stated explicitly" in by_predicate["INFLUENCES"]["rationale"]


async def test_mock_people_never_emit_contact_data() -> None:
    result = await MockPeopleAdapter().run(request("mock_people", "discover_people"))
    blob = json.dumps(result)
    assert "@" not in blob
    assert all(p["public_profile_url"] is None for p in result["people"])


async def test_website_evidence_stays_on_target_domain() -> None:
    result = await MockWebAdapter().run(
        request("mock_web", "fetch_company_evidence", "acme.example")
    )
    assert all(e["source_url"].startswith("https://acme.example/") for e in result["evidence"])


async def test_budget_is_enforced() -> None:
    req = request("mock_people", "discover_people")
    req["budget"] = {"max_records": 1, "max_evidence": 1}
    result = await MockPeopleAdapter().run(req)
    assert len(result["people"]) == 1
    assert result["relationships"] == []
    assert_contract(result)


async def test_registry_outage_is_retryable_failure() -> None:
    with pytest.raises(AdapterFailure) as exc:
        await MockRegistryAdapter().run(
            request("mock_registry", "fetch_registry_record", "outage.example")
        )
    assert exc.value.code == "SOURCE_UNAVAILABLE"
    assert exc.value.retryable is True


async def test_activity_wraps_result_with_attempt() -> None:
    env = ActivityEnvironment()
    acts = ResearchActivities()
    invocation = await env.run(acts.run_adapter, request("mock_web", "fetch_company_evidence"))
    assert invocation["attempt"] == 1
    assert_contract(invocation["result"])


async def test_activity_maps_failures_to_application_errors() -> None:
    env = ActivityEnvironment()
    acts = ResearchActivities()
    with pytest.raises(ApplicationError) as outage:
        await env.run(
            acts.run_adapter,
            request("mock_registry", "fetch_registry_record", "outage.example"),
        )
    assert outage.value.type == "SOURCE_UNAVAILABLE"
    assert outage.value.non_retryable is False

    with pytest.raises(ApplicationError) as unknown:
        await env.run(acts.run_adapter, request("unknown_source", "discover_people"))
    assert unknown.value.type == "SOURCE_DISABLED"
    assert unknown.value.non_retryable is True

    with pytest.raises(ApplicationError) as unsupported:
        await env.run(acts.run_adapter, request("mock_web", "discover_people"))
    assert unsupported.value.type == "UNSUPPORTED_OPERATION"


async def test_activity_clamps_oversized_budgets() -> None:
    env = ActivityEnvironment()
    acts = ResearchActivities()
    req = request("mock_people", "discover_people")
    req["budget"] = {"max_records": 10_000, "max_evidence": 10_000}
    invocation = await env.run(acts.run_adapter, req)
    assert len(invocation["result"]["people"]) <= 200


def test_mock_providers_can_be_disabled() -> None:
    assert build_registry({"FEATURE_MOCK_PROVIDERS": "false"}) == {}
    assert set(build_registry({})) == {"mock_web", "mock_people", "mock_registry"}
