"""Temporal activities. Workers return normalized payloads and never write canonical data."""

from __future__ import annotations

import asyncio
import logging

from temporalio import activity
from temporalio.exceptions import ApplicationError

from .adapters import AdapterFailure, SourceAdapter, build_registry
from .models import AdapterInvocation, AdapterRequest

log = logging.getLogger(__name__)

MAX_RECORDS_CEILING = 200
MAX_EVIDENCE_CEILING = 50
ADAPTER_TIMEOUT_SECONDS = 45


class ResearchActivities:
    def __init__(self, adapters: dict[str, SourceAdapter] | None = None) -> None:
        self._adapters = build_registry() if adapters is None else adapters

    @activity.defn(name="run_adapter")
    async def run_adapter(self, request: AdapterRequest) -> AdapterInvocation:
        info = activity.info()
        source_key = request["source_key"]
        adapter = self._adapters.get(source_key)
        if adapter is None:
            raise ApplicationError(
                f"Source {source_key} is not enabled on this worker",
                type="SOURCE_DISABLED",
                non_retryable=True,
            )
        if request["operation"] not in adapter.operations:
            raise ApplicationError(
                f"Source {source_key} does not support {request['operation']}",
                type="UNSUPPORTED_OPERATION",
                non_retryable=True,
            )

        bounded: AdapterRequest = {
            **request,
            "budget": {
                "max_records": max(0, min(request["budget"]["max_records"], MAX_RECORDS_CEILING)),
                "max_evidence": max(
                    0, min(request["budget"]["max_evidence"], MAX_EVIDENCE_CEILING)
                ),
            },
        }
        log.info(
            "adapter.start",
            extra={
                "source_key": source_key,
                "operation": request["operation"],
                "attempt": info.attempt,
                "correlation_id": request["correlation_id"],
            },
        )
        try:
            async with asyncio.timeout(ADAPTER_TIMEOUT_SECONDS):
                result = await adapter.run(bounded)
        except AdapterFailure as err:
            log.warning(
                "adapter.failed",
                extra={"source_key": source_key, "code": err.code, "attempt": info.attempt},
            )
            raise ApplicationError(
                err.message, type=err.code, non_retryable=not err.retryable
            ) from err
        except TimeoutError as err:
            raise ApplicationError(
                "Adapter exceeded its time budget", type="SOURCE_TIMEOUT"
            ) from err
        return {"attempt": info.attempt, "result": result}
