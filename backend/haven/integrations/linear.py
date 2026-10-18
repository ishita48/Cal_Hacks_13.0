"""Linear: the facilities ticket that is actually created when the manager approves.

Key-gated by LINEAR_API_KEY and LINEAR_TEAM_ID (the team the issue lands in). Without them the
ticket step is simulated and the action detail says so. The ticket's identifier and URL come back
into the world as the step's detail; nothing else about the world depends on Linear.
"""

from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("haven.linear")

URL = "https://api.linear.app/graphql"
_MUTATION = """
mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}
"""


def configured() -> bool:
    return bool(os.environ.get("LINEAR_API_KEY") and os.environ.get("LINEAR_TEAM_ID"))


async def create_issue(title: str, body: str, priority: int = 1) -> dict | None:
    """Create an issue; returns {"identifier", "url"} or None when not configured / failed."""
    key = os.environ.get("LINEAR_API_KEY")
    team = os.environ.get("LINEAR_TEAM_ID")
    if not key or not team:
        return None
    payload = {"query": _MUTATION, "variables": {"input": {"teamId": team, "title": title[:250], "description": body,
                                                           "priority": priority}}}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(URL, json=payload, headers={"Authorization": key, "Content-Type": "application/json"})
        data = r.json() if r.status_code < 300 else {}
        issue = (data.get("data") or {}).get("issueCreate", {}).get("issue")
        if not issue:
            log.warning("linear %s: %s", r.status_code, r.text[:200])
            return None
        return {"identifier": issue["identifier"], "url": issue["url"]}
    except (httpx.HTTPError, ValueError):
        log.exception("linear request failed")
        return None
