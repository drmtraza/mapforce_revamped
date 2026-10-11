"""Bounded HTML extraction for public company pages.

Only structured, publisher-declared data is turned into claims (meta tags and JSON-LD
Organization nodes). Free text is kept as evidence content, never parsed into facts.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any

MAX_TEXT_CHARS = 50_000
MAX_LINKS = 500
MAX_JSON_LD_SCRIPTS = 5
MAX_JSON_LD_CHARS = 200_000
ORG_TYPES = frozenset(
    {"Organization", "Corporation", "LocalBusiness", "OnlineBusiness", "NGO", "Company"}
)
_SKIP_TEXT = frozenset({"script", "style", "noscript", "template", "svg", "head"})
_WS = re.compile(r"\s+")


@dataclass
class Organization:
    name: str | None = None
    legal_name: str | None = None
    description: str | None = None
    country_code: str | None = None


@dataclass
class Page:
    title: str | None = None
    meta: dict[str, str] = field(default_factory=dict)
    lang: str | None = None
    canonical: str | None = None
    links: list[str] = field(default_factory=list)
    text: str = ""
    organization: Organization | None = None


def _clean(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = _WS.sub(" ", value).strip()
    return text[:limit] or None


class _Parser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.page = Page()
        self._text: list[str] = []
        self._text_len = 0
        self._skip_depth = 0
        self._in_title = False
        self._title: list[str] = []
        self._json_ld: list[str] | None = None
        self.json_ld_blocks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "html" and a.get("lang"):
            self.page.lang = a["lang"][:20]
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key in {"description", "og:site_name", "og:title", "og:description"}:
                value = _clean(a.get("content"), 1000)
                if value and key not in self.page.meta:
                    self.page.meta[key] = value
        elif tag == "link" and "canonical" in a.get("rel", "").lower().split():
            self.page.canonical = a.get("href", "")[:2048] or None
        elif tag == "a" and a.get("href") and len(self.page.links) < MAX_LINKS:
            self.page.links.append(a["href"][:2048])
        if tag == "script" and a.get("type", "").lower() == "application/ld+json":
            if len(self.json_ld_blocks) < MAX_JSON_LD_SCRIPTS:
                self._json_ld = []
        if tag in _SKIP_TEXT:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag == "script" and self._json_ld is not None:
            self.json_ld_blocks.append("".join(self._json_ld)[:MAX_JSON_LD_CHARS])
            self._json_ld = None
        if tag in _SKIP_TEXT and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._json_ld is not None:
            self._json_ld.append(data)
            return
        if self._in_title:
            self._title.append(data)
            return
        if self._skip_depth or self._text_len >= MAX_TEXT_CHARS:
            return
        chunk = data.strip()
        if chunk:
            self._text.append(chunk)
            self._text_len += len(chunk) + 1

    def finish(self) -> Page:
        self.page.title = _clean("".join(self._title), 300)
        self.page.text = _WS.sub(" ", " ".join(self._text)).strip()[:MAX_TEXT_CHARS]
        self.page.organization = _organization(self.json_ld_blocks)
        return self.page


def _nodes(data: Any, depth: int = 0) -> list[dict[str, Any]]:
    if depth > 4:
        return []
    if isinstance(data, list):
        return [n for item in data[:50] for n in _nodes(item, depth + 1)]
    if isinstance(data, dict):
        found = [data]
        if isinstance(data.get("@graph"), list):
            found += _nodes(data["@graph"], depth + 1)
        return found
    return []


def _is_org(node: dict[str, Any]) -> bool:
    types = node.get("@type")
    names = types if isinstance(types, list) else [types]
    return any(isinstance(t, str) and t in ORG_TYPES for t in names)


def _country(address: Any) -> str | None:
    if isinstance(address, list) and address:
        address = address[0]
    if not isinstance(address, dict):
        return None
    country = address.get("addressCountry")
    if isinstance(country, dict):
        country = country.get("name")
    if isinstance(country, str) and re.fullmatch(r"[A-Za-z]{2}", country.strip()):
        return country.strip().upper()
    return None


def _organization(blocks: list[str]) -> Organization | None:
    for raw in blocks:
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        for node in _nodes(data):
            if _is_org(node):
                return Organization(
                    name=_clean(node.get("name"), 300),
                    legal_name=_clean(node.get("legalName"), 300),
                    description=_clean(node.get("description"), 1000),
                    country_code=_country(node.get("address")),
                )
    return None


def parse_html(html: str) -> Page:
    parser = _Parser()
    try:
        parser.feed(html)
        parser.close()
    except AssertionError:  # html.parser can assert on badly malformed markup
        pass
    return parser.finish()
