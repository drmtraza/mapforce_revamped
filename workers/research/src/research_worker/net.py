"""Outbound HTTP safety for adapters that fetch third-party URLs (SSRF guard).

* `PublicOnlyResolver` resolves a hostname once and refuses it if *any* address is not
  globally routable (private, loopback, link-local/metadata, CGNAT, multicast, reserved,
  or IPv4 embedded in NAT64/6to4/Teredo IPv6). aiohttp connects to the validated
  addresses it returns, so a second DNS answer cannot redirect the connection (rebinding).
* `check_url` keeps requests on the target site: http(s) only, allowed ports only, no
  embedded credentials, no IP-literal hosts (those would bypass the resolver).
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from aiohttp.abc import AbstractResolver, ResolveResult
from yarl import URL

GetAddrInfo = Callable[..., Awaitable[list[tuple[Any, ...]]]]

_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_HOSTNAME = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


class BlockedAddressError(OSError):
    """The hostname resolved to an address outside the public internet."""


def is_public_ip(value: str) -> bool:
    try:
        addr = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address):
        embedded: list[ipaddress.IPv4Address] = []
        if addr.ipv4_mapped:
            embedded.append(addr.ipv4_mapped)
        if addr.sixtofour:
            embedded.append(addr.sixtofour)
        if addr.teredo:
            embedded.extend(addr.teredo)
        if addr in _NAT64:
            embedded.append(ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF))
        if any(not is_public_ip(str(e)) for e in embedded):
            return False
    return addr.is_global and not addr.is_multicast


def is_hostname(value: str) -> bool:
    return bool(_HOSTNAME.match(value))


def is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return True


class PublicOnlyResolver(AbstractResolver):
    def __init__(self, getaddrinfo: GetAddrInfo | None = None) -> None:
        self._getaddrinfo = getaddrinfo

    async def resolve(
        self, host: str, port: int = 0, family: socket.AddressFamily = socket.AF_INET
    ) -> list[ResolveResult]:
        gai = self._getaddrinfo or asyncio.get_running_loop().getaddrinfo
        infos = await gai(host, port, type=socket.SOCK_STREAM, family=family)
        results: list[ResolveResult] = []
        for fam, _type, proto, _canon, sockaddr in infos:
            ip = str(sockaddr[0])
            if not is_public_ip(ip):
                raise BlockedAddressError(f"{host} resolves to a non-public address")
            results.append(
                {
                    "hostname": host,
                    "host": ip,
                    "port": port,
                    "family": fam,
                    "proto": proto,
                    "flags": socket.AI_NUMERICHOST,
                }
            )
        if not results:
            raise OSError(f"{host} did not resolve")
        return results

    async def close(self) -> None:
        return None


def site_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def check_url(url: URL, domain: str, allowed_ports: Iterable[int]) -> str | None:
    """Returns a reason string if the URL must not be fetched for this site, else None."""
    if url.scheme not in ("http", "https"):
        return "scheme"
    if url.user or url.password:
        return "credentials"
    host = (url.host or "").lower().rstrip(".")
    if not host:
        return "host"
    if is_ip_literal(host):
        return "ip_literal"
    if not site_matches(host, domain):
        return "off_site"
    if url.port not in set(allowed_ports):
        return "port"
    return None
