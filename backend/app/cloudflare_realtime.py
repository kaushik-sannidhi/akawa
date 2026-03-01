"""
Cloudflare Calls — Meetings (Sessions) & Participants API + TURN credentials.

The @cloudflare/realtimekit SDK on the frontend talks to Cloudflare Calls.
We use the raw Calls HTTP API server-side to create sessions and issue auth tokens.

Env vars required:
    CF_APP_ID         – Cloudflare Calls App ID
    CF_APP_SECRET     – Cloudflare Calls App Secret
    CF_TURN_KEY_ID    – (optional) Cloudflare TURN key ID
    CF_TURN_API_TOKEN – (optional) Cloudflare TURN API token
"""

import os
import time
import logging
import requests
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# ── Env vars ──────────────────────────────────────────────────────────────────

def _env() -> Dict[str, str]:
    return {
        "app_id":       os.getenv("CF_APP_ID", ""),
        "app_secret":   os.getenv("CF_APP_SECRET", ""),
        "turn_key_id":  os.getenv("CF_TURN_KEY_ID", ""),
        "turn_token":   os.getenv("CF_TURN_API_TOKEN", ""),
    }

def _base() -> str:
    e = _env()
    return f"https://rtc.live.cloudflare.com/v1/apps/{e['app_id']}"

def _headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {_env()['app_secret']}",
        "Content-Type": "application/json",
    }

def is_configured() -> bool:
    e = _env()
    return bool(e["app_id"] and e["app_secret"])


# ── TURN credential cache ────────────────────────────────────────────────────
_turn_cache: Dict[str, Any] = {}
_TURN_TTL_SECONDS = 3600
_TURN_REFRESH_BUFFER = 300


# ─────────────────────────────────────── Sessions (Meetings) ─────────────────

def create_meeting(title: str) -> Optional[Dict[str, Any]]:
    """
    Create a Cloudflare Calls session (acts as a 'meeting room').
    Returns {"meeting_id": ..., "title": ...} or None.
    """
    if not is_configured():
        logger.warning("Cloudflare Calls not configured (no CF_APP_ID / CF_APP_SECRET).")
        return None

    try:
        resp = requests.post(
            f"{_base()}/sessions/new",
            json={},
            headers=_headers(),
            timeout=10,
        )
        if resp.status_code in (200, 201):
            body = resp.json()
            session_id = body.get("sessionId") or body.get("session_id") or body.get("id")
            if session_id:
                logger.info(f"Created CF Calls session {session_id} — {title}")
                return {"meeting_id": session_id, "title": title}
        logger.error(f"create_meeting failed: {resp.status_code} {resp.text[:400]}")
        return None
    except Exception as exc:
        logger.error(f"create_meeting exception: {exc}")
        return None


def close_meeting(meeting_id: str, retries: int = 2) -> bool:
    """Cloudflare Calls sessions auto-expire. Log for housekeeping."""
    if not is_configured() or not meeting_id:
        return False
    logger.info(f"CF Calls session {meeting_id} marked closed (auto-expires)")
    return True


# ──────────────────────────────────── Participants ────────────────────────────

_PRESET_PUBLISHER = "group_call_host"
_PRESET_VIEWER    = "group_call_participant"


def add_participant(
    meeting_id: str,
    participant_id: str,
    name: str = "participant",
    role: str = "viewer",
) -> Optional[Dict[str, Any]]:
    """
    Add a participant to a Calls session using the New Tracks API.

    For Cloudflare Calls, we create a new session for each participant
    and return the session info so the frontend SDK can connect.

    The @cloudflare/realtimekit SDK handles the WebRTC negotiation.
    We just need to provide an auth token (the app secret is used to
    generate per-participant tokens via the Calls API).
    """
    if not is_configured() or not meeting_id:
        return None

    try:
        # For Cloudflare Calls, we create participant sessions
        # The auth token is the meeting_id + participant combo
        # The frontend SDK will use this to establish WebRTC
        resp = requests.post(
            f"{_base()}/sessions/new",
            json={},
            headers=_headers(),
            timeout=10,
        )
        if resp.status_code in (200, 201):
            body = resp.json()
            session_id = body.get("sessionId") or body.get("session_id") or body.get("id")
            if session_id:
                # For the RTK SDK, the auth token combines the app secret
                # and session info. The SDK expects a specific token format.
                # We pass the session ID as the token — the SDK init will
                # use it to connect to the correct session.
                logger.info(f"Added {role} participant {participant_id} → session {session_id}")
                return {
                    "participant_id": participant_id,
                    "token": session_id,  # Session ID used by frontend
                    "custom_participant_id": participant_id,
                    "role": role,
                    "session_id": session_id,
                    "meeting_id": meeting_id,
                }
        logger.error(f"add_participant failed: {resp.status_code} {resp.text[:400]}")
        return None
    except Exception as exc:
        logger.error(f"add_participant exception: {exc}")
        return None


def remove_participant(meeting_id: str, participant_id: str) -> bool:
    """Sessions auto-expire. Nothing to explicitly remove."""
    return True


# ─────────────────────────────────── TURN credentials ────────────────────────

def get_turn_credentials() -> Dict[str, Any]:
    """
    Return ICE server config for WebRTC.
    Cached for _TURN_TTL_SECONDS, falls back to STUN-only.
    """
    global _turn_cache

    e = _env()
    if not (e["turn_key_id"] and e["turn_token"]):
        return _stun_only()

    now = time.time()
    if _turn_cache and _turn_cache.get("expires_at", 0) - now > _TURN_REFRESH_BUFFER:
        return {"iceServers": _turn_cache["ice_servers"]}

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
                logger.info("Refreshed Cloudflare TURN credentials (cached)")
                return {"iceServers": servers}

        logger.warning(f"TURN credential request failed: {resp.status_code}")
    except Exception as exc:
        logger.error(f"TURN credential exception: {exc}")

    return _stun_only()


def _stun_only() -> Dict[str, Any]:
    return {
        "iceServers": [
            {"urls": "stun:stun.cloudflare.com:3478"},
            {"urls": "stun:stun.l.google.com:19302"},
        ]
    }