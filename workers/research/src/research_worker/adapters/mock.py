"""Deterministic mock adapters for development and tests.

All output is synthetic: names come from a fixed fictional list, URLs stay on the
submitted domain or RFC 2606 reserved hosts, and no network calls are made.
The same domain always yields the same people, claims and content hashes.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote_plus

from ..models import (
    AdapterRequest,
    AdapterResult,
    CompanyCandidate,
    CompanyClaim,
    Evidence,
    Operation,
    Person,
    Relationship,
    empty_result,
)
from .base import AdapterFailure, BaseAdapter, require_company, require_query

FIRST_NAMES = ("Avery", "Jordan", "Riley", "Morgan", "Casey", "Quinn", "Taylor", "Rowan")
LAST_NAMES = ("Example", "Sample", "Placeholder", "Testcase", "Fixture", "Mockridge")
INDUSTRIES = ("Software", "Logistics", "Manufacturing", "Financial Services", "Healthcare")
COUNTRIES = ("GB", "US", "DE", "FR", "IE", "NL")
EMPLOYEE_BANDS = ("11-50", "51-200", "201-500", "501-1000")

# (title, department, seniority) in a fixed order so relationships are stable.
ROLES = (
    ("VP Engineering", "Engineering", "vp"),
    ("Engineering Manager", "Engineering", "manager"),
    ("Head of Procurement", "Procurement", "director"),
    ("IT Operations Lead", "IT", "manager"),
)

PROVIDER = "mock"
LICENSE = {"synthetic": True, "terms": "synthetic-fixture"}


def _seed(domain: str) -> int:
    return int.from_bytes(hashlib.sha256(domain.encode()).digest()[:8], "big")


def _hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _evidence(ref: str, url: str, text: str, extra: dict[str, Any] | None = None) -> Evidence:
    return {
        "ref": ref,
        "source_url": url,
        "fetched_at": _now(),
        "published_at": None,
        "content_type": "text/html",
        "content_hash": _hash(text),
        "excerpt": text[:2000],
        "normalized_content": {"text": text, **(extra or {})},
        "license_metadata": dict(LICENSE),
    }


def _company_name(domain: str) -> str:
    label = domain.split(".")[0].replace("-", " ")
    return f"{label.title()} Example Ltd"


class MockWebAdapter(BaseAdapter):
    source_key = "mock_web"
    provider = PROVIDER
    operations: frozenset[Operation] = frozenset({"fetch_company_evidence"})

    async def fetch_company_evidence(self, request: AdapterRequest) -> AdapterResult:
        domain = require_company(request)["domain"]
        seed = _seed(domain)
        name = _company_name(domain)
        industry = INDUSTRIES[seed % len(INDUSTRIES)]
        country = COUNTRIES[(seed >> 8) % len(COUNTRIES)]
        band = EMPLOYEE_BANDS[(seed >> 16) % len(EMPLOYEE_BANDS)]

        home = (
            f"{name} provides {industry.lower()} solutions. "
            f"Headquartered in {country}. Team size {band} employees."
        )
        about = f"About {name}: founded to serve {industry.lower()} customers."
        evidence = [
            _evidence("ev-home", f"https://{domain}/", home, {"title": name}),
            _evidence("ev-about", f"https://{domain}/about", about, {"title": f"About {name}"}),
        ][: request["budget"]["max_evidence"]]
        refs = {e["ref"] for e in evidence}

        def claim(predicate: str, value: str, conf: float, ref: str) -> CompanyClaim:
            return {
                "predicate": predicate,
                "value": value,
                "claim_type": "source_fact",
                "confidence": conf,
                "evidence_refs": [ref],
            }

        claims = [
            claim("canonical_name", name, 0.9, "ev-home"),
            claim("industry", industry, 0.7, "ev-home"),
            claim("country_code", country, 0.7, "ev-home"),
            claim("employee_band", band, 0.6, "ev-home"),
            claim("description", about, 0.8, "ev-about"),
        ]
        result = empty_result(self.source_key, self.provider, "fetch_company_evidence")
        result["usage"] = {
            "request_count": len(evidence),
            "units": len(evidence),
            "unit_type": "pages",
        }
        result["evidence"] = evidence
        result["company_claims"] = [c for c in claims if set(c["evidence_refs"]) <= refs]
        return result


class MockPeopleAdapter(BaseAdapter):
    source_key = "mock_people"
    provider = PROVIDER
    operations: frozenset[Operation] = frozenset({"discover_people"})

    async def discover_people(self, request: AdapterRequest) -> AdapterResult:
        domain = require_company(request)["domain"]
        seed = _seed(domain)
        count = min(3 + seed % 2, request["budget"]["max_records"])
        names = [
            f"{FIRST_NAMES[(seed + i) % len(FIRST_NAMES)]} "
            f"{LAST_NAMES[(seed // 7 + i) % len(LAST_NAMES)]}"
            for i in range(count)
        ]

        lines = [f"{n}, {ROLES[i][0]}." for i, n in enumerate(names)]
        if count >= 2:
            lines.append(f"{names[1]} reports to {names[0]}.")
        text = " ".join(lines)
        evidence = [_evidence("ev-team", f"https://{domain}/about/team", text, {"section": "team"})]

        people: list[Person] = [
            {
                "ref": f"p{i}",
                "full_name": n,
                "title": ROLES[i][0],
                "department": ROLES[i][1],
                "seniority": ROLES[i][2],
                "public_profile_url": None,
                "claim_type": "source_fact",
                "confidence": 0.8 if i < 2 else 0.6,
                "evidence_refs": ["ev-team"],
            }
            for i, n in enumerate(names)
        ]
        relationships: list[Relationship] = []
        if count >= 2:
            relationships.append(
                {
                    "subject_ref": "p1",
                    "predicate": "REPORTS_TO",
                    "object_ref": "p0",
                    "status": "verified",
                    "claim_type": "source_fact",
                    "confidence": 0.8,
                    "rationale": "The team page states this reporting line explicitly.",
                    "evidence_refs": ["ev-team"],
                }
            )
        if count >= 3:
            relationships.append(
                {
                    "subject_ref": "p2",
                    "predicate": "INFLUENCES",
                    "object_ref": "p0",
                    "status": "inferred",
                    "claim_type": "provider_fact",
                    "confidence": 0.5,
                    "rationale": (
                        "Procurement commonly participates in engineering purchases; "
                        "influence is not stated explicitly on the source page."
                    ),
                    "evidence_refs": ["ev-team"],
                }
            )

        result = empty_result(self.source_key, self.provider, "discover_people")
        result["usage"] = {"request_count": 1, "units": len(people), "unit_type": "records"}
        result["evidence"] = evidence
        result["people"] = people
        result["relationships"] = relationships
        return result


class MockRegistryAdapter(BaseAdapter):
    """Simulates a public registry. Domains containing 'outage' model a provider outage."""

    source_key = "mock_registry"
    provider = PROVIDER
    operations: frozenset[Operation] = frozenset({"fetch_registry_record"})

    async def fetch_registry_record(self, request: AdapterRequest) -> AdapterResult:
        domain = require_company(request)["domain"]
        if "outage" in domain:
            raise AdapterFailure("SOURCE_UNAVAILABLE", "Mock registry returned 503", retryable=True)
        number = f"{_seed(domain) % 100_000_000:08d}"
        text = f"Registry record {number}: {_company_name(domain)}, status active."
        evidence = [
            _evidence("ev-registry", f"https://registry.example/company/{number}", text),
        ]
        result = empty_result(self.source_key, self.provider, "fetch_registry_record")
        result["usage"] = {"request_count": 1, "units": 1, "unit_type": "records"}
        result["evidence"] = evidence
        result["company_claims"] = [
            {
                "predicate": "registry_identifier",
                "value": number,
                "claim_type": "source_fact",
                "confidence": 0.95,
                "evidence_refs": ["ev-registry"],
            }
        ]
        return result


SEARCH_SUFFIXES = ("works", "labs", "group", "systems", "partners", "dynamics", "hub", "co")


class MockSearchAdapter(BaseAdapter):
    """Synthetic company search. Queries containing 'outage' model a provider outage."""

    source_key = "mock_search"
    provider = PROVIDER
    operations: frozenset[Operation] = frozenset({"discover_companies"})

    async def discover_companies(self, request: AdapterRequest) -> AdapterResult:
        query = require_query(request)
        text = " ".join(query["text"].lower().split())
        if "outage" in text:
            raise AdapterFailure("SOURCE_UNAVAILABLE", "Mock search returned 503", retryable=True)
        words = re.findall(r"[a-z0-9]+", text)[:3] or ["company"]
        stem = "-".join(words)[:40].strip("-")
        countries = query["country_codes"] or list(COUNTRIES)
        seed = _seed(text)
        count = min(5, request["budget"]["max_records"])

        candidates: list[CompanyCandidate] = []
        listing: list[dict[str, str]] = []
        for i in range(count):
            suffix = SEARCH_SUFFIXES[(seed + i) % len(SEARCH_SUFFIXES)]
            domain = f"{stem}-{suffix}.example"
            name = f"{stem.replace('-', ' ').title()} {suffix.title()} Example"
            description = f"{name} serves {text} customers (synthetic search result)."
            listing.append({"name": name, "url": f"https://{domain}/", "snippet": description})
            candidates.append(
                {
                    "ref": f"c{i}",
                    "name": name,
                    "domain": domain,
                    "country_code": countries[(seed + i) % len(countries)],
                    "description": description,
                    "claim_type": "provider_fact",
                    "confidence": 0.5,
                    "evidence_refs": ["ev-search"],
                }
            )
        body = json.dumps(listing, sort_keys=True)
        evidence: Evidence = {
            "ref": "ev-search",
            "source_url": f"https://search.mock.example/?q={quote_plus(text)}",
            "fetched_at": _now(),
            "published_at": None,
            "content_type": "application/json",
            "content_hash": _hash(body),
            "excerpt": "; ".join(item["name"] for item in listing)[:2000],
            "normalized_content": {"query": text, "results": listing},
            "license_metadata": dict(LICENSE),
        }
        result = empty_result(self.source_key, self.provider, "discover_companies")
        result["usage"] = {"request_count": 1, "units": 1, "unit_type": "queries"}
        result["evidence"] = [evidence]
        result["companies"] = candidates
        return result
