from __future__ import annotations

import os

from .base import SourceAdapter
from .mock import MockPeopleAdapter, MockRegistryAdapter, MockWebAdapter


def build_registry(env: dict[str, str] | None = None) -> dict[str, SourceAdapter]:
    """Adapters enabled for this worker. Real providers are added behind explicit flags."""
    env = dict(os.environ) if env is None else env
    adapters: dict[str, SourceAdapter] = {}
    if env.get("FEATURE_MOCK_PROVIDERS", "true").lower() == "true":
        for adapter in (MockWebAdapter(), MockPeopleAdapter(), MockRegistryAdapter()):
            adapters[adapter.source_key] = adapter
    return adapters
