"""Worker entrypoint: `python -m research_worker.main`."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from typing import Any

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import ResearchActivities

_RESERVED = set(vars(logging.makeLogRecord({})))


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
            "logger": record.name,
            "service": "mapforce-research-worker",
        }
        payload.update({k: v for k, v in vars(record).items() if k not in _RESERVED})
        return json.dumps(payload, default=str)


async def run() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), handlers=[handler])

    client = await Client.connect(
        os.environ.get("TEMPORAL_ADDRESS", "localhost:7233"),
        namespace=os.environ.get("TEMPORAL_NAMESPACE", "default"),
    )
    activities = ResearchActivities()
    worker = Worker(
        client,
        task_queue=os.environ.get("RESEARCH_TASK_QUEUE", "research-python"),
        activities=[activities.run_adapter],
        max_concurrent_activities=int(os.environ.get("MAX_CONCURRENT_ACTIVITIES", "20")),
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows event loops lack signal handlers
            signal.signal(sig, lambda *_: stop.set())

    logging.getLogger(__name__).info("research worker started")
    async with worker:
        await stop.wait()


if __name__ == "__main__":
    asyncio.run(run())
