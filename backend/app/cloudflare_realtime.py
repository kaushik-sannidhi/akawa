"""
Cloudflare Realtime Kit — Meetings & Participants API + TURN credentials.

Uses the Cloudflare Realtime Kit API (built on Dyte) for WebRTC live
streaming via their global SFU network.  Each "stream" maps to a
Realtime Kit "meeting".  Publishers and viewers join as participants
and receive auth tokens that the frontend SDK consumes.

Env vars required:
    CF_ACCOUNT_ID      – Cloudflare account ID
    CF_REALTIME_APP_ID – Realtime Kit App ID (from Cloudflare dashboard → Calls → Realtime Kit)
    CF_REALTIME_TOKEN  – Cloudflare API token with "Realtime" or "Realtime Admin" permission
    CF_TURN_KEY_ID     – (optional) Cloudflare TURN key ID for extra NAT traversal
    CF_TURN_API_TOKEN  – (optional) Cloudflare TURN API token
"""

import os
import logging
import requests
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
CF_REALTIME_APP_ID = os.getenv("CF_REALTIME_APP_ID", "")
CF_REALTIME_TOKEN = os.getenv("CF_REALTIME_TOKEN", "")
CF_TURN_KEY_ID = os.getenv("CF_TURN_KEY_ID", "")
CF_TURN_API_TOKEN = os.getenv("CF_TURN_API_TOKEN", "")

_BASE = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/realtime/kit/{CF_REALTIME_APP_ID}"


def _headers():
    return {
        "Authorization": f"Bearer {CF_REALTIME_TOKEN}",
        "Content-Type": "application/json",
    }


def is_configured() -> bool:
    return bool(CF_ACCOUNT_ID and CF_REALTIME_APP_ID and CF_REALTIME_TOKEN)


# ────────────────────────────────────── Meetings ──────────────────────────────

def create_meeting(title: str) -> Optional[Dict[str, Any]]:
    """
    Create a Realtime Kit meeting.
    Returns { "meeting_id": ..., "title": ..., ... } or None.
    """
    if not is_configured():
        logger.warning("Cloudflare Realtime Kit not configured.")
        return None

    try:
        resp = requests.post(
            f"{_BASE}/meetings",
            json={"title": title},
            headers=_headers(),
            timeout=10,
        )
        if resp.status_code in (200, 201):
            body = resp.json()
            if body.get("success"):
                data = body["data"]
                logger.info(f"Created Realtime Kit meeting {data['id']} — {title}")
                return {
                    "meeting_id": data["id"],
                    "title": data.get("title", title),
                }
        logger.error(f"create_meeting failed: {resp.status_code} {resp.text[:400]}")
        return None
    except Exception as exc:
        logger.error(f"create_meeting exception: {exc}")
        return None


def close_meeting(meeting_id: str) -> bool:
    """
    Kick all participants from a meeting (effectively closes it).
    """
    if not is_configured() or not meeting_id:
        return False
    try:
        resp = requests.post(
            f"{_BASE}/meetings/{meeting_id}/active-session/kick-all",
            json={},
            headers=_headers(),
            timeout=10,
        )
        ok = resp.status_code in (200, 201, 204)
        if ok:
            logger.info(f"Closed meeting {meeting_id}")
        return ok
    except Exception as exc:
        logger.error(f"close_meeting exception: {exc}")
        return False


# ─────────────────────────────────── Participants ─────────────────────────────

def add_participant(
    meeting_id: str,
    participant_id: str,
    name: str = "participant",
    preset: str = "group_call_host",
) -> Optional[Dict[str, Any]]:
    """
    Add a participant to a meeting and get their auth token.
    The token is passed to the frontend SDK for joining.

    preset="group_call_host" gives publish+subscribe permissions.

    Returns { "participant_id": ..., "token": ... } or None.
    """
    if not is_configured() or not meeting_id:
        return None

    try:
        payload = {
            "custom_participant_id": participant_id,
            "name": name,
            "preset_name": preset,
        }
        resp = requests.post(
            f"{_BASE}/meetings/{meeting_id}/participants",
            json=payload,
            headers=_headers(),
            timeout=10,
        )
        if resp.status_code in (200, 201):
            body = resp.json()
            if body.get("success"):
                data = body["data"]
                logger.info(f"Added participant {data['id']} to meeting {meeting_id}")
                return {
                    "participant_id": data["id"],
                    "token": data["token"],
                    "custom_participant_id": data.get("custom_participant_id", participant_id),
                }
        logger.error(f"add_participant failed: {resp.status_code} {resp.text[:400]}")
        return None
    except Exception as exc:
        logger.error(f"add_participant exception: {exc}")
        return None


def remove_participant(meeting_id: str, participant_id: str) -> bool:
    """Remove / kick a participant from a meeting."""
    if not is_configured() or not meeting_id or not participant_id:
        return False
    try:
        resp = requests.delete(
            f"{_BASE}/meetings/{meeting_id}/participants/{participant_id}",
            headers=_headers(),
            timeout=10,
        )
        return resp.status_code in (200, 204)
    except Exception as exc:
        logger.error(f"remove_participant exception: {exc}")
        return False


# ────────────────────────────────── TURN credentials ──────────────────────────

def get_turn_credentials() -> Dict[str, Any]:
    """
    Fetch short-lived TURN credentials from Cloudflare.
    Falls back to STUN-only if TURN is not configured.
    """
    if CF_TURN_KEY_ID and CF_TURN_API_TOKEN:
        try:
            resp = requests.post(
                f"https://rtc.live.cloudflare.com/v1/turn/keys/{CF_TURN_KEY_ID}/credentials/generate",
                json={"ttl": 86400},
                headers={
                    "Authorization": f"Bearer {CF_TURN_API_TOKEN}",
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
            if resp.status_code in (200, 201):
                data = resp.json()
                ice = data.get("iceServers", {})
                username = ice.get("username", "")
                credential = ice.get("credential", "")
                if username and credential:
                    return {
                        "iceServers": [
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
                    }
            logger.warning(f"TURN credential request failed: {resp.status_code}")
        except Exception as exc:
            logger.error(f"TURN credential exception: {exc}")

    return {
        "iceServers": [
            {"urls": "stun:stun.cloudflare.com:3478"},
            {"urls": "stun:stun.l.google.com:19302"},
        ]
    }
