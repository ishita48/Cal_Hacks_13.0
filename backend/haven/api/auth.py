"""Who is asking: the viewer's role, decided by the server, never by the client.

Four roles: `resident`, `ra`, `maintenance`, `admin`. With CLERK_SECRET_KEY set, every request that needs a
viewer carries Clerk's session token (`Authorization: Bearer <jwt>`); the token is verified against Clerk's
JWKS and the role is read from the user's `public_metadata.role` (set in the Clerk dashboard, or by an admin
later). A user with no role is a `resident`: the least they can see. `public_metadata.person_id` links the
account to a roster id (a resident or an RA), which is how "my room" and "my floor" are known.

Without Clerk the demo runs open as it always has: the viewer is whatever `X-Haven-Role` says (default
`admin`), and `source == "demo"` says so to every surface that shows it.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import asdict, dataclass
from typing import Literal

import httpx
import jwt
from fastapi import Header, HTTPException

log = logging.getLogger("haven.auth")

Role = Literal["resident", "ra", "maintenance", "admin"]
ROLES: tuple[Role, ...] = ("resident", "ra", "maintenance", "admin")
API = "https://api.clerk.com/v1"
_CACHE_S = 60.0


@dataclass(frozen=True)
class Viewer:
    role: Role
    source: Literal["clerk", "demo"]
    user_id: str | None = None
    name: str | None = None
    email: str | None = None
    person_id: str | None = None       # roster id: the resident or RA this account is

    def public(self) -> dict:
        return asdict(self)


def configured() -> bool:
    return bool(os.environ.get("CLERK_SECRET_KEY"))


def _role(value: object) -> Role:
    return value if value in ROLES else "resident"          # type: ignore[return-value]


class Clerk:
    """Verifies session tokens and looks users up, with a short cache so a page load is one round trip."""

    def __init__(self) -> None:
        self._jwks: tuple[float, dict] | None = None
        self._users: dict[str, tuple[float, Viewer]] = {}

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {os.environ['CLERK_SECRET_KEY']}"}

    async def jwks(self) -> dict:
        if self._jwks and time.monotonic() - self._jwks[0] < 3600:
            return self._jwks[1]
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{API}/jwks", headers=self._headers())
        r.raise_for_status()
        self._jwks = (time.monotonic(), r.json())
        return self._jwks[1]

    async def user(self, user_id: str) -> dict:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{API}/users/{user_id}", headers=self._headers())
        r.raise_for_status()
        return r.json()

    async def verify(self, token: str) -> str:
        """The token's user id, or HTTPException(401)."""
        try:
            kid = jwt.get_unverified_header(token).get("kid")
            keys = (await self.jwks()).get("keys", [])
            jwk = next((k for k in keys if k.get("kid") == kid), None)
            if jwk is None:
                self._jwks = None                       # keys rotated: refetch next time
                raise HTTPException(401, "unknown signing key")
            key = jwt.PyJWK(jwk).key
            claims = jwt.decode(token, key, algorithms=["RS256"], options={"require": ["exp", "sub"]}, leeway=5)
        except jwt.PyJWTError as e:
            raise HTTPException(401, f"invalid session: {e}") from None
        except httpx.HTTPError:
            log.exception("clerk jwks fetch failed")
            raise HTTPException(503, "sign-in service unreachable") from None
        parties = [p for p in os.environ.get("CLERK_AUTHORIZED_PARTIES", "").split(",") if p]
        if parties and claims.get("azp") not in parties:
            raise HTTPException(401, "session issued for another origin")
        return claims["sub"]

    async def viewer(self, token: str) -> Viewer:
        uid = await self.verify(token)
        hit = self._users.get(uid)
        if hit and time.monotonic() - hit[0] < _CACHE_S:
            return hit[1]
        try:
            u = await self.user(uid)
        except httpx.HTTPError:
            log.exception("clerk user lookup failed")
            raise HTTPException(503, "sign-in service unreachable") from None
        meta = u.get("public_metadata") or {}
        primary = u.get("primary_email_address_id")
        email = next((e.get("email_address") for e in u.get("email_addresses") or [] if e.get("id") == primary), None)
        name = " ".join(x for x in (u.get("first_name"), u.get("last_name")) if x) or None
        v = Viewer(role=_role(meta.get("role")), source="clerk", user_id=uid, name=name, email=email,
                   person_id=meta.get("person_id"))
        self._users[uid] = (time.monotonic(), v)
        return v


clerk = Clerk()


async def viewer(authorization: str | None = Header(default=None),
                 x_haven_role: str | None = Header(default=None),
                 x_haven_person: str | None = Header(default=None)) -> Viewer:
    """FastAPI dependency: the verified viewer (Clerk) or the declared one (demo)."""
    if not configured():
        return Viewer(role=_role(x_haven_role) if x_haven_role else "admin", source="demo", person_id=x_haven_person)
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "sign in first")
    return await clerk.viewer(authorization.split(" ", 1)[1].strip())


def require(viewer_: Viewer, *roles: Role) -> Viewer:
    if viewer_.role not in roles:
        raise HTTPException(403, f"{viewer_.role} cannot do this")
    return viewer_
