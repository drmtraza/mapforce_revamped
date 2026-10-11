from __future__ import annotations

import socket
from typing import Any

import pytest
from yarl import URL

from research_worker.net import BlockedAddressError, PublicOnlyResolver, check_url, is_public_ip

BLOCKED = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",  # cloud metadata
    "100.64.0.1",  # carrier-grade NAT
    "0.0.0.0",  # noqa: S104 - test vector
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",  # NAT64 of 169.254.169.254
    "2002:7f00:1::1",  # 6to4 of 127.0.0.1
    "ff02::1",
    "not-an-ip",
]
ALLOWED = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]


@pytest.mark.parametrize("ip", BLOCKED)
def test_non_public_addresses_are_blocked(ip: str) -> None:
    assert is_public_ip(ip) is False


@pytest.mark.parametrize("ip", ALLOWED)
def test_public_addresses_are_allowed(ip: str) -> None:
    assert is_public_ip(ip) is True


def fake_gai(*ips: str) -> Any:
    async def gai(host: str, port: int, **_: Any) -> list[tuple[Any, ...]]:
        out: list[tuple[Any, ...]] = []
        for ip in ips:
            fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
            out.append((fam, socket.SOCK_STREAM, 6, "", (ip, port)))
        return out

    return gai


async def test_resolver_refuses_host_if_any_address_is_private() -> None:
    resolver = PublicOnlyResolver(fake_gai("8.8.8.8", "10.0.0.5"))
    with pytest.raises(BlockedAddressError):
        await resolver.resolve("mixed.example", 443)


async def test_resolver_returns_pinned_public_addresses() -> None:
    resolver = PublicOnlyResolver(fake_gai("8.8.8.8", "2606:4700:4700::1111"))
    results = await resolver.resolve("public.example", 443)
    assert [r["host"] for r in results] == ["8.8.8.8", "2606:4700:4700::1111"]
    assert all(r["flags"] == socket.AI_NUMERICHOST for r in results)


async def test_resolver_rejects_empty_answers() -> None:
    with pytest.raises(OSError, match="did not resolve"):
        await PublicOnlyResolver(fake_gai()).resolve("nothing.example", 443)


@pytest.mark.parametrize(
    ("url", "reason"),
    [
        ("https://acme.example/about", None),
        ("http://www.acme.example/", None),
        ("ftp://acme.example/", "scheme"),
        ("file:///etc/passwd", "scheme"),
        ("https://user:pw@acme.example/", "credentials"),
        ("https://127.0.0.1/", "ip_literal"),
        ("https://[::1]/", "ip_literal"),
        ("https://acme.example.evil.example/", "off_site"),
        ("https://notacme.example/", "off_site"),
        ("https://acme.example:8080/", "port"),
    ],
)
def test_url_policy(url: str, reason: str | None) -> None:
    assert check_url(URL(url), "acme.example", (80, 443)) == reason
