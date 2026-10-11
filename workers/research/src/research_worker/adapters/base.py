"""Provider adapter interface. Real providers implement the same contract as the mocks."""

from __future__ import annotations

from typing import Protocol

from ..models import AdapterRequest, AdapterResult, Operation


class AdapterFailure(Exception):
    """A provider-level failure with a stable code; `retryable` drives Temporal retry policy."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class SourceAdapter(Protocol):
    source_key: str
    provider: str
    operations: frozenset[Operation]

    async def run(self, request: AdapterRequest) -> AdapterResult:
        """Execute one bounded operation and return a normalized, schema-conforming result."""
        ...

    async def health_check(self) -> bool: ...
