"""Provider adapter interface. Real providers implement the same contract as the mocks."""

from __future__ import annotations

from collections.abc import Callable
from contextvars import ContextVar
from typing import Any, Protocol

from ..models import AdapterRequest, AdapterResult, CompanyRef, DiscoveryQuery, Operation, PersonRef


class AdapterFailure(Exception):
    """A provider-level failure with a stable code; `retryable` drives Temporal retry policy."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


_progress: ContextVar[Callable[[dict[str, Any]], None] | None] = ContextVar(
    "adapter_progress", default=None
)


def set_progress_reporter(fn: Callable[[dict[str, Any]], None] | None) -> None:
    _progress.set(fn)


def report_progress(**detail: Any) -> None:
    """Heartbeat hook for long adapters; lets Temporal detect stalls and deliver cancellation."""
    fn = _progress.get()
    if fn is not None:
        fn(detail)


class SourceAdapter(Protocol):
    source_key: str
    provider: str
    operations: frozenset[Operation]

    async def run(self, request: AdapterRequest) -> AdapterResult:
        """Execute one bounded operation and return a normalized, schema-conforming result."""
        ...

    async def health_check(self) -> bool: ...


def require_company(request: AdapterRequest) -> CompanyRef:
    company = request.get("company")
    if not company:
        raise AdapterFailure("INVALID_REQUEST", "This operation needs a company", retryable=False)
    return company


def require_person(request: AdapterRequest) -> PersonRef:
    person = request.get("person")
    if not person or not person["full_name"].strip():
        raise AdapterFailure("INVALID_REQUEST", "This operation needs a person", retryable=False)
    return person


def require_query(request: AdapterRequest) -> DiscoveryQuery:
    query = request.get("query")
    if not query or not query["text"].strip():
        raise AdapterFailure("INVALID_REQUEST", "This operation needs a query", retryable=False)
    return query


class BaseAdapter:
    """Implements the full adapter interface; providers override only what they support.

    Interface methods: discover_companies, discover_people, fetch_company_evidence,
    fetch_registry_record, fetch_intent_signals, enrich_contact, health_check.
    """

    source_key: str
    provider: str
    operations: frozenset[Operation]

    async def run(self, request: AdapterRequest) -> AdapterResult:
        op = request["operation"]
        if op not in self.operations:
            raise _unsupported(self.source_key, op)
        if op == "discover_companies":
            return await self.discover_companies(request)
        if op == "discover_people":
            return await self.discover_people(request)
        if op == "fetch_company_evidence":
            return await self.fetch_company_evidence(request)
        if op == "fetch_intent_signals":
            return await self.fetch_intent_signals(request)
        if op == "enrich_contact":
            return await self.enrich_contact(request)
        return await self.fetch_registry_record(request)

    async def health_check(self) -> bool:
        return True

    async def discover_companies(self, request: AdapterRequest) -> AdapterResult:
        raise _unsupported(self.source_key, "discover_companies")

    async def discover_people(self, request: AdapterRequest) -> AdapterResult:
        raise _unsupported(self.source_key, "discover_people")

    async def fetch_company_evidence(self, request: AdapterRequest) -> AdapterResult:
        raise _unsupported(self.source_key, "fetch_company_evidence")

    async def fetch_registry_record(self, request: AdapterRequest) -> AdapterResult:
        raise _unsupported(self.source_key, "fetch_registry_record")

    async def fetch_intent_signals(self, request: AdapterRequest) -> AdapterResult:
        raise _unsupported(self.source_key, "fetch_intent_signals")

    async def enrich_contact(self, request: AdapterRequest) -> AdapterResult:
        raise _unsupported(self.source_key, "enrich_contact")


def _unsupported(source_key: str, op: str) -> AdapterFailure:
    return AdapterFailure(
        "UNSUPPORTED_OPERATION", f"Source {source_key} does not support {op}", retryable=False
    )
