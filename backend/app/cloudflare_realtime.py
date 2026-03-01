"""
Cloudflare RealtimeKit backend integration.

This module provisions meeting rooms and participant auth tokens through the
Cloudflare Calls API and returns TURN credentials for WebRTC fallback.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)

API_TIMEOUT_SECONDS = 12


def _first_env(*keys: str) -> str:
    for key in keys:
        value = (os.getenv(key) or "").strip()
        if value:
            return value
    return ""


def _env() -> Dict[str, str]:
    return {
        "account_id": _first_env("CF_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "R2_ACCOUNT_ID"),
        "app_id": _first_env("CF_CALLS_APP_ID", "CF_APP_ID"),
        "api_token": _first_env("CF_CALLS_API_TOKEN", "CF_CALLS_APP_SECRET", "CF_APP_SECRET"),
        "turn_key_id": _first_env("CF_TURN_KEY_ID"),
        "turn_token": _first_env("CF_TURN_API_TOKEN"),
    }


def _calls_base() -> str:
    env = _env()
    return (
        "https://api.cloudflare.com/client/v4/accounts/"
        f"{env['account_id']}/realtime/kit/{env['app_id']}"
    )


def _calls_headers() -> Dict[str, str]:
    env = _env()
    return {
        "Authorization": f"Bearer {env['api_token']}",
        "Content-Type": "application/json",
    }


def is_configured() -> bool:
    env = _env()
    return bool(env["account_id"] and env["app_id"] and env["api_token"])


def status() -> Dict[str, Any]:
    env = _env()
    return {
        "configured": is_configured(),
        "has_account_id": bool(env["account_id"]),
        "has_app_id": bool(env["app_id"]),
        "has_api_token": bool(env["api_token"]),
        "has_turn_key_id": bool(env["turn_key_id"]),
        "has_turn_api_token": bool(env["turn_token"]),
        "account_id_suffix": env["account_id"][-6:] if env["account_id"] else "",
        "app_id_suffix": env["app_id"][-6:] if env["app_id"] else "",
    }


def _parse_cf_response(response: requests.Response, operation: str) -> Optional[Dict[str, Any]]:
    try:
        payload = response.json()
    except Exception:
        logger.error(
            "%s failed with non-JSON response (%s): %s",
            operation,
            response.status_code,
            response.text[:300],
        )
        return None

    if response.status_code not in (200, 201):
        logger.error("%s failed (%s): %s", operation, response.status_code, payload)
        return None

    if payload.get("success") is False:
        logger.error("%s unsuccessful response: %s", operation, payload)
        return None

    return payload.get("result") or payload.get("data") or payload


def create_meeting(title: str) -> Optional[Dict[str, Any]]:
    """Create a Calls meeting and return a normalized result."""
    if not is_configured():
        logger.warning("Cloudflare Calls is not configured. Missing account/app/token env vars.")
        return None

    meeting_name = (title or "").strip()[:120] or f"akawa-{int(time.time())}"

    try:
        response = requests.post(
            f"{_calls_base()}/meetings",
            headers=_calls_headers(),
            json={"title": meeting_name},
            timeout=API_TIMEOUT_SECONDS,
        )
        result = _parse_cf_response(response, "create_meeting")
        if not result:
            return None

        meeting_id = result.get("id") or result.get("meeting_id")
        if not meeting_id:
            logger.error("create_meeting response missing meeting id: %s", result)
            return None

        return {
            "meeting_id": meeting_id,
            "name": result.get("title") or result.get("name") or meeting_name,
        }
    except Exception as exc:
        logger.error("create_meeting exception: %s", exc)
        return None


def close_meeting(meeting_id: str) -> bool:
    """Attempt to delete a meeting. Missing meetings are treated as closed."""
    if not meeting_id or not is_configured():
        return False

    try:
        response = requests.delete(
            f"{_calls_base()}/meetings/{meeting_id}",
            headers=_calls_headers(),
            timeout=API_TIMEOUT_SECONDS,
        )
        if response.status_code in (200, 202, 204, 404):
            return True
        logger.warning("close_meeting returned status %s for %s", response.status_code, meeting_id)
        return False
    except Exception as exc:
        logger.error("close_meeting exception for %s: %s", meeting_id, exc)
        return False


def add_participant(
    meeting_id: str,
    participant_id: str,
    name: str = "participant",
    role: str = "viewer",
) -> Optional[Dict[str, Any]]:
    """Add participant to an existing meeting and return auth token."""
    if not meeting_id or not is_configured():
        return None

    safe_role = "publisher" if role == "publisher" else "viewer"
    safe_participant_id = (participant_id or "").strip()[:128]
    if not safe_participant_id:
        safe_participant_id = f"anon-{int(time.time() * 1000)}"

    payload = {
        "name": (name or "participant").strip()[:120] or "participant",
        "custom_participant_id": safe_participant_id,
        "preset_name": safe_role, # RealtimeKit uses presets
    }

    try:
        response = requests.post(
            f"{_calls_base()}/meetings/{meeting_id}/participants",
            headers=_calls_headers(),
            json=payload,
            timeout=API_TIMEOUT_SECONDS,
        )
        result = _parse_cf_response(response, "add_participant")
        if not result:
            return None

        token = result.get("token")
        if not token:
            logger.error("add_participant response missing token: %s", result)
            return None

        return {
            "participant_id": result.get("id") or safe_participant_id,
            "token": token,
            "custom_participant_id": safe_participant_id,
            "role": safe_role,
            "meeting_id": meeting_id,
        }
    except Exception as exc:
        logger.error("add_participant exception: %s", exc)
        return None


def remove_participant(meeting_id: str, participant_id: str) -> bool:
    """Participants are transient; no explicit removal required."""
    return bool(meeting_id and participant_id)


_turn_cache: Dict[str, Any] = {}
_TURN_TTL_SECONDS = 3600
_TURN_REFRESH_BUFFER = 300


def get_turn_credentials() -> Dict[str, Any]:
    """Return ICE server config for WebRTC, preferring Cloudflare TURN."""
    global _turn_cache

    env = _env()
    if not (env["turn_key_id"] and env["turn_token"]):
        return _stun_only()

    now = time.time()
    if _turn_cache and _turn_cache.get("expires_at", 0) - now > _TURN_REFRESH_BUFFER:
        return {"iceServers": _turn_cache["ice_servers"]}

    try:
        response = requests.post(
            f"https://rtc.live.cloudflare.com/v1/turn/keys/{env['turn_key_id']}/credentials/generate",
            headers={
                "Authorization": f"Bearer {env['turn_token']}",
                "Content-Type": "application/json",
            },
            json={"ttl": _TURN_TTL_SECONDS},
            timeout=API_TIMEOUT_SECONDS,
        )
        if response.status_code in (200, 201):
            data = response.json()
            ice = data.get("iceServers", {})
            username = ice.get("username", "")
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
                return {"iceServers": servers}

        logger.warning("TURN credentials request failed with status %s", response.status_code)
    except Exception as exc:
        logger.error("TURN credential exception: %s", exc)

    return _stun_only()


def _stun_only() -> Dict[str, Any]:
    return {
        "iceServers": [
            {"urls": "stun:stun.cloudflare.com:3478"},
            {"urls": "stun:stun.l.google.com:19302"},
        ]
    }
