from __future__ import annotations

import os

from .base import SourceAdapter
from .brave_search import BraveSearchAdapter
from .company_site import CompanySiteAdapter, CrawlerSettings
from .mock import MockPeopleAdapter, MockRegistryAdapter, MockSearchAdapter, MockWebAdapter

DEFAULT_CRAWLER_INFO_URL = "https://example.invalid/mapforce-bot"


def _flag(env: dict[str, str], name: str, default: str) -> bool:
    return env.get(name, default).strip().lower() == "true"


def build_registry(env: dict[str, str] | None = None) -> dict[str, SourceAdapter]:
    """Adapters this worker can run. Whether a source is *used* is decided by the control
    plane (global registry flag + workspace setting); a source missing here fails closed
    with SOURCE_DISABLED."""
    env = dict(os.environ) if env is None else env
    adapters: list[SourceAdapter] = []
    if _flag(env, "FEATURE_MOCK_PROVIDERS", "true"):
        adapters += [
            MockWebAdapter(),
            MockPeopleAdapter(),
            MockRegistryAdapter(),
            MockSearchAdapter(),
        ]
    if _flag(env, "FEATURE_COMPANY_SITE_CRAWLER", "true"):
        info_url = env.get("CRAWLER_INFO_URL", "").strip() or DEFAULT_CRAWLER_INFO_URL
        adapters.append(
            CompanySiteAdapter(CrawlerSettings(user_agent=f"MapforceBot/0.1 (+{info_url})"))
        )
    brave_key = env.get("BRAVE_SEARCH_API_KEY", "").strip()
    if brave_key:
        adapters.append(BraveSearchAdapter(brave_key))
    return {a.source_key: a for a in adapters}
