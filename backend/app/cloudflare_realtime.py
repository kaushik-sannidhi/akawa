"""
Cloudflare Realtime Kit — Meetings & Participants API + TURN credentials.

Env vars required:
    CF_ACCOUNT_ID      – Cloudflare account ID
    CF_REALTIME_APP_ID – Realtime Kit App ID
    CF_REALTIME_TOKEN  – Cloudflare API token (Realtime / Realtime Admin permission)
    CF_TURN_KEY_ID     – (optional) Cloudflare TURN key ID
    CF_TURN_API_TOKEN  – (optional) Cloudflare TURN API token
"""

import os
import time
import logging
import requests
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# ── Env vars read lazily so Docker/Railway env injection works correctly ──────
def _env() -> Dict[str, str]:
    return {
        "account_id":  os.getenv("CF_ACCOUNT_ID", ""),
        "app_id":      os.getenv("CF_REALTIME_APP_ID", ""),
        "token":       os.getenv("CF_REALTIME_TOKEN", ""),
        "turn_key_id": os.getenv("CF_TURN_KEY_ID", ""),
        "turn_token":  os.getenv("CF_TURN_API_TOKEN", ""),
    }

def _base() -> str:
    e = _env()
    return (f"https://api.cloudflare.com/client/v4/accounts/{e['account_id']}"
            f"/realtime/kit/{e['app_id']}")

def _headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {_env()['token']}",
        "Content-Type": "application/json",
    }

def is_configured() -> bool:
    e = _env()
    return bool(e["account_id"] and e["app_id"] and e["token"])


# ── TURN credential cache — valid 24h, refresh 30 min before expiry ───────────
_turn_cache: Dict[str, Any] = {}   # {"ice_servers": [...], "expires_at": float}
_TURN_TTL_SECONDS = 3600           # 1-hour TTL — sufficient for any session
_TURN_REFRESH_BUFFER = 300         # refresh 5 min before expiry


# ─────────────────────────────────────── Meetings ────────────────────────────

def create_meeting(title: str) -> Optional[Dict[str, Any]]:
    """
    Create a Realtime Kit meeting.
    Returns {"meeting_id": ..., "title": ...} or None.
    """
    if not is_configured():
        logger.warning("Cloudflare Realtime Kit not configured — skipping create_meeting.")
        return None

    try:
        resp = requests.post(
            f"{_base()}/meetings",
            json={"title": title},
            headers=_headers(),
            timeout=10,
        )
        if resp.status_code in (200, 201):
            body = resp.json()
            if body.get("success"):
                data = body["data"]
                logger.info(f"Created CF meeting {data['id']} — {title}")
                return {"meeting_id": data["id"], "title": data.get("title", title)}
        logger.error(f"create_meeting failed: {resp.status_code} {resp.text[:400]}")
        return None
    except Exception as exc:
        logger.error(f"create_meeting exception: {exc}")
        return None


def close_meeting(meeting_id: str, retries: int = 2) -> bool:
    """
    Kick all participants from a meeting.
    Retries up to `retries` times on network failure so the meeting
    doesn't stay open on Cloudflare's side after local cleanup.
    """
    if not is_configured() or not meeting_id:
        return False

    for attempt in range(1, retries + 2):  # retries+1 total attempts
        try:
            resp = requests.post(
                f"{_base()}/meetings/{meeting_id}/active-session/kick-all",
                json={},
                headers=_headers(),
                timeout=10,
            )
            if resp.status_code in (200, 201, 204):
                logger.info(f"Closed CF meeting {meeting_id} (attempt {attempt})")
                return True
            # 404 means meeting is already gone — treat as success
            if resp.status_code == 404:
                logger.info(f"CF meeting {meeting_id} already closed (404)")
                return True
            logger.warning(
                f"close_meeting attempt {attempt} failed: "
                f"{resp.status_code} {resp.text[:200]}"
            )
        except Exception as exc:
            logger.error(f"close_meeting attempt {attempt} exception: {exc}")

        if attempt <= retries:
            time.sleep(attempt)  # simple backoff: 1s, 2s

    logger.error(
        f"close_meeting failed after {retries + 1} attempts for meeting {meeting_id}. "
        f"Meeting may still be open on Cloudflare — manual cleanup may be required."
    )
    return False


# ──────────────────────────────────── Participants ────────────────────────────

# Preset names in Realtime Kit
_PRESET_PUBLISHER = "group_call_host"       # publish + subscribe
_PRESET_VIEWER    = "group_call_participant" # subscribe only — no publish permission


def add_participant(
    meeting_id: str,
    participant_id: str,
    name: str = "participant",
    role: str = "viewer",           # "publisher" | "viewer"
) -> Optional[Dict[str, Any]]:
    """
    Add a participant and return their auth token for the frontend SDK.

    role="publisher"  → group_call_host    (publish + subscribe)
    role="viewer"     → group_call_participant (subscribe only)

    Using the correct role ensures viewers can't accidentally publish a feed.
    """
    if not is_configured() or not meeting_id:
        return None

    preset = _PRESET_PUBLISHER if role == "publisher" else _PRESET_VIEWER

    try:
        resp = requests.post(
            f"{_base()}/meetings/{meeting_id}/participants",
            json={
                "custom_participant_id": participant_id,
                "name": name,
                "preset_name": preset,
            },
            headers=_headers(),
            timeout=10,
        )
        if resp.status_code in (200, 201):
            body = resp.json()
            if body.get("success"):
                data = body["data"]
                logger.info(
                    f"Added {role} {data['id']} to meeting {meeting_id}"
                )
                return {
                    "participant_id": data["id"],
                    "token": data["token"],
                    "custom_participant_id": data.get("custom_participant_id", participant_id),
                    "role": role,
                }
        logger.error(f"add_participant failed: {resp.status_code} {resp.text[:400]}")
        return None
    except Exception as exc:
        logger.error(f"add_participant exception: {exc}")
        return None


def remove_participant(meeting_id: str, participant_id: str) -> bool:
    """Kick a single participant from a meeting."""
    if not is_configured() or not meeting_id or not participant_id:
        return False
    try:
        resp = requests.delete(
            f"{_base()}/meetings/{meeting_id}/participants/{participant_id}",
            headers=_headers(),
            timeout=10,
        )
        return resp.status_code in (200, 204)
    except Exception as exc:
        logger.error(f"remove_participant exception: {exc}")
        return False


# ─────────────────────────────────── TURN credentials ────────────────────────

def get_turn_credentials() -> Dict[str, Any]:
    """
    Return ICE server config for WebRTC.

    Credentials are cached for _TURN_TTL_SECONDS and reused across all
    viewer joins — avoids hammering the TURN API on concurrent joins.
    Falls back to STUN-only if TURN is unconfigured or the API call fails.
    """
    global _turn_cache

    e = _env()
    if not (e["turn_key_id"] and e["turn_token"]):
        return _stun_only()

    # Return cached credentials if still fresh
    now = time.time()
    if _turn_cache and _turn_cache.get("expires_at", 0) - now > _TURN_REFRESH_BUFFER:
        return {"iceServers": _turn_cache["ice_servers"]}

    # Fetch new credentials
    try:
        resp = requests.post(
            f"https://rtc.live.cloudflare.com/v1/turn/keys/{e['turn_key_id']}/credentials/generate",
            json={"ttl": _TURN_TTL_SECONDS},
            headers={
                "Authorization": f"Bearer {e['turn_token']}",
                "Content-Type": "application/json",
            },
            timeout=10,
        )
        if resp.status_code in (200, 201):
            ice = resp.json().get("iceServers", {})
            username   = ice.get("username", "")
            credential = ice.get("credential", "")
            if username and credential:
                servers = [
                    {"urls": "stun:stun.cloudflare.com:3478"},
                    {
                        "urls": [
                            "turn:turn.cloudflare.com:3478?transport=udp",
                            "turn:turn.cloudflare.com:3478?transport=tcp",
                            "turns:turn.cloudflare.com:5349?transport=tcp",
                        ],
                        "username": username,
                        "credential": credential,
                    },
                ]
                _turn_cache = {
                    "ice_servers": servers,
                    "expires_at": now + _TURN_TTL_SECONDS,
                }
                logger.info("Refreshed Cloudflare TURN credentials (cached for 1h)")
                return {"iceServers": servers}

        logger.warning(f"TURN credential request failed: {resp.status_code} — falling back to STUN")
    except Exception as exc:
        logger.error(f"TURN credential exception: {exc} — falling back to STUN")

    return _stun_only()


def _stun_only() -> Dict[str, Any]:
    return {
        "iceServers": [
            {"urls": "stun:stun.cloudflare.com:3478"},
            {"urls": "stun:stun.l.google.com:19302"},
        ]
    }