"""Wire types shared with the control plane (see contracts/adapter-result.v1.schema.json)."""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

Operation = Literal[
    "fetch_company_evidence",
    "discover_people",
    "fetch_registry_record",
    "discover_companies",
    "fetch_intent_signals",
    "enrich_contact",
]
SourcedClaimType = Literal["source_fact", "provider_fact"]


class CompanyRef(TypedDict):
    domain: str
    name: str


class PersonRef(TypedDict):
    full_name: str
    title: NotRequired[str | None]


class DiscoveryQuery(TypedDict):
    text: str
    country_codes: list[str]


class Budget(TypedDict):
    max_records: int
    max_evidence: int


class AdapterRequest(TypedDict):
    source_key: str
    operation: Operation
    company: NotRequired[CompanyRef]
    person: NotRequired[PersonRef]
    query: NotRequired[DiscoveryQuery]
    budget: Budget
    correlation_id: str


class AdapterError(TypedDict):
    code: str
    message: str
    retryable: bool


class Usage(TypedDict):
    request_count: int
    units: float
    unit_type: str


class Evidence(TypedDict):
    ref: str
    source_url: str
    fetched_at: str
    published_at: str | None
    content_type: str
    content_hash: str
    excerpt: str
    normalized_content: dict[str, Any]
    license_metadata: dict[str, Any]


class CompanyClaim(TypedDict):
    predicate: str
    value: str
    claim_type: SourcedClaimType
    confidence: float
    evidence_refs: list[str]


class Person(TypedDict):
    ref: str
    full_name: str
    title: str | None
    department: str | None
    seniority: str | None
    public_profile_url: str | None
    claim_type: SourcedClaimType
    confidence: float
    evidence_refs: list[str]


class Relationship(TypedDict):
    subject_ref: str
    predicate: Literal["REPORTS_TO", "INFLUENCES", "DECIDES_FOR", "WORKS_WITH"]
    object_ref: str
    status: Literal["verified", "inferred"]
    claim_type: Literal["source_fact", "provider_fact", "model_inference"]
    confidence: float
    rationale: str
    evidence_refs: list[str]


class Signal(TypedDict):
    ref: str
    signal_type: Literal["hiring", "funding", "procurement", "news", "product", "other"]
    title: str
    summary: str
    implies_budget: bool
    claim_type: SourcedClaimType
    confidence: float
    country_code: str | None
    observed_at: str
    evidence_refs: list[str]


class ContactPoint(TypedDict):
    ref: str
    contact_type: Literal["work_email", "work_phone"]
    value: str
    status: Literal[
        "unverified",
        "provider_verified",
        "deliverable_likely",
        "invalid",
        "catch_all",
        "unknown",
        "suppressed",
    ]
    verification_method: Literal["none", "pattern", "mx", "provider", "user"]
    verified_at: str | None
    claim_type: SourcedClaimType
    confidence: float
    evidence_refs: list[str]


class CompanyCandidate(TypedDict):
    ref: str
    name: str
    domain: str
    country_code: str | None
    description: str | None
    claim_type: SourcedClaimType
    confidence: float
    evidence_refs: list[str]


class AdapterResult(TypedDict):
    schema_version: Literal[1]
    source_key: str
    provider: str
    operation: Operation
    status: Literal["succeeded", "failed"]
    error: AdapterError | None
    usage: Usage
    evidence: list[Evidence]
    company_claims: list[CompanyClaim]
    companies: NotRequired[list[CompanyCandidate]]
    people: list[Person]
    relationships: list[Relationship]
    signals: NotRequired[list[Signal]]
    contact_points: NotRequired[list[ContactPoint]]


class AdapterInvocation(TypedDict):
    attempt: int
    result: AdapterResult


def empty_result(source_key: str, provider: str, operation: Operation) -> AdapterResult:
    return {
        "schema_version": 1,
        "source_key": source_key,
        "provider": provider,
        "operation": operation,
        "status": "succeeded",
        "error": None,
        "usage": {"request_count": 0, "units": 0, "unit_type": "records"},
        "evidence": [],
        "company_claims": [],
        "people": [],
        "relationships": [],
    }
