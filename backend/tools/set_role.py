"""Give a Clerk account its HAVEN role (and optionally its roster id), from the terminal.

    uv run --env-file .env python tools/set_role.py                      # list accounts and their roles
    uv run --env-file .env python tools/set_role.py you@example.com admin
    uv run --env-file .env python tools/set_role.py ra@example.com ra <roster person id>

The role lives in the user's Clerk `public_metadata.role` (see haven/api/auth.py); nothing in the browser can
set it. A fresh instance has no admin, so the first one is granted here (or in the Clerk dashboard). The
backend caches a viewer for a minute, so a change shows on the next page load after that.
"""

import os
import sys

import httpx

API = "https://api.clerk.com/v1"
ROLES = ("resident", "ra", "maintenance", "admin")


def email(u: dict) -> str:
    return next((e["email_address"] for e in u.get("email_addresses") or [] if e["id"] == u.get("primary_email_address_id")), "")


def main() -> None:
    key = os.environ.get("CLERK_SECRET_KEY")
    if not key:
        sys.exit("CLERK_SECRET_KEY is not set (run with: uv run --env-file .env python tools/set_role.py ...)")
    client = httpx.Client(base_url=API, headers={"Authorization": f"Bearer {key}"}, timeout=15.0)
    users = client.get("/users", params={"limit": 200}).raise_for_status().json()
    if len(sys.argv) < 3:
        for u in users:
            meta = u.get("public_metadata") or {}
            print(f"{email(u) or u['id']:40} {meta.get('role', 'resident (no role set)'):24} {meta.get('person_id', '')}")
        return
    who, role = sys.argv[1].lower(), sys.argv[2]
    if role not in ROLES:
        sys.exit(f"role must be one of {', '.join(ROLES)}")
    match = [u for u in users if email(u).lower() == who or u["id"] == who]
    if not match:
        sys.exit(f"no Clerk account for {who}; sign up once at /app first")
    meta = {"role": role} | ({"person_id": sys.argv[3]} if len(sys.argv) > 3 else {})
    client.patch(f"/users/{match[0]['id']}/metadata", json={"public_metadata": meta}).raise_for_status()
    print(f"{email(match[0])} is now {role}" + (f" ({sys.argv[3]})" if len(sys.argv) > 3 else ""))


if __name__ == "__main__":
    main()
