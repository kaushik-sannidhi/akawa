"""
Cloudflare Calls (Realtime SFU) + TURN service.

Uses Cloudflare Calls API for WebRTC SFU-based live streaming
and Cloudflare TURN for NAT traversal across devices/networks.

Env vars required:
    CF_APP_ID      – Cloudflare Calls App ID
    CF_APP_SECRET  – Cloudflare Calls App Secret (bearer token)
    CF_TURN_KEY_ID – Cloudflare TURN token key ID
    CF_TURN_API_TOKEN – Cloudflare TURN API token
"""

import os
import logging
import requests
from typing import Dict, Any, Optional, List

logger = logging.getLogger(__name__)

CF_APP_ID = os.getenv("CF_APP_ID", "")
CF_APP_SECRET = os.getenv("CF_APP_SECRET", "")
CF_TURN_KEY_ID = os.getenv("CF_TURN_KEY_ID", "")
CF_TURN_API_TOKEN = os.getenv("CF_TURN_API_TOKEN", "")

CALLS_API_BASE = f"https://rtc.live.cloudflare.com/v1/apps/{CF_APP_ID}"

def _calls_headers():
    return {
        "Authorization": f"Bearer {CF_APP_SECRET}",
        "Content-Type": "application/json",
    }


def is_configured() -> bool:
    """Check if Cloudflare Calls is configured."""
    return bool(CF_APP_ID and CF_APP_SECRET)


def create_session() -> Optional[Dict[str, Any]]:
    """
    Create a new Cloudflare Calls session.
    Returns {"sessionId": "..."} or None.
    """
    if not is_configured():
        logger.warning("Cloudflare Calls not configured. Set CF_APP_ID and CF_APP_SECRET.")
        return None

    try:
        resp = requests.post(
            f"{CALLS_API_BASE}/sessions/new",
            json={},
            headers=_calls_headers(),
            timeout=10,
        )
        if resp.status_code in (200, 201):
            data = resp.json()
            session_id = data.get("sessionId", "")
            if session_id:
                logger.info(f"Created Cloudflare Calls session: {session_id}")
                return {"sessionId": session_id}
        logger.error(f"CF Calls create_session failed: {resp.status_code} {resp.text[:300]}")
        return None
    except Exception as exc:
        logger.error(f"CF Calls create_session exception: {exc}")
        return None


def push_track(session_id: str, sdp_offer: str, track_name: str) -> Optional[Dict[str, Any]]:
    """
    Push a track (publish) to a Cloudflare Calls session.

    The publisher sends their SDP offer with a sendonly transceiver.
    Returns the SDP answer and track info from the SFU.
    """
    if not is_configured() or not session_id:
        return None

    try:
        payload = {
            "sessionDescription": {
                "type": "offer",
                "sdp": sdp_offer,
            },
            "tracks": [
                {
                    "location": "local",
                    "trackName": track_name,
                    "mid": "0",  # first media section for video
                },
            ],
        }

        resp = requests.post(
            f"{CALLS_API_BASE}/sessions/{session_id}/tracks/new",
            json=payload,
            headers=_calls_headers(),
            timeout=10,
        )

        if resp.status_code in (200, 201):
            data = resp.json()
            return {
                "sdp_answer": data.get("sessionDescription", {}).get("sdp", ""),
                "tracks": data.get("tracks", []),
                "requiresImmediateRenegotiation": data.get("requiresImmediateRenegotiation", False),
            }

        logger.error(f"CF Calls push_track failed: {resp.status_code} {resp.text[:300]}")
        return None
    except Exception as exc:
        logger.error(f"CF Calls push_track exception: {exc}")
        return None


def pull_track(session_id: str, sdp_offer: str, track_name: str,
               publisher_session_id: str) -> Optional[Dict[str, Any]]:
    """
    Pull a track (subscribe/view) from a Cloudflare Calls session.

    The viewer sends an SDP offer with a recvonly transceiver.
    Returns the SDP answer from the SFU.
    """
    if not is_configured() or not session_id:
        return None

    try:
        payload = {
            "sessionDescription": {
                "type": "offer",
                "sdp": sdp_offer,
            },
            "tracks": [
                {
                    "location": "remote",
                    "trackName": track_name,
                    "sessionId": publisher_session_id,
                    "mid": "0",
                },
            ],
        }

        resp = requests.post(
            f"{CALLS_API_BASE}/sessions/{session_id}/tracks/new",
            json=payload,
            headers=_calls_headers(),
            timeout=10,
        )

        if resp.status_code in (200, 201):
            data = resp.json()
            return {
                "sdp_answer": data.get("sessionDescription", {}).get("sdp", ""),
                "tracks": data.get("tracks", []),
                "requiresImmediateRenegotiation": data.get("requiresImmediateRenegotiation", False),
            }

        logger.error(f"CF Calls pull_track failed: {resp.status_code} {resp.text[:300]}")
        return None
    except Exception as exc:
        logger.error(f"CF Calls pull_track exception: {exc}")
        return None


def renegotiate(session_id: str, sdp_offer: str) -> Optional[str]:
    """
    Renegotiate an existing session (e.g., after adding tracks).
    Returns the new SDP answer or None.
    """
    if not is_configured() or not session_id:
        return None

    try:
        payload = {
            "sessionDescription": {
                "type": "offer",
                "sdp": sdp_offer,
            },
        }

        resp = requests.put(
            f"{CALLS_API_BASE}/sessions/{session_id}/renegotiate",
            json=payload,
            headers=_calls_headers(),
            timeout=10,
        )

        if resp.status_code in (200, 201):
            data = resp.json()
            return data.get("sessionDescription", {}).get("sdp", "")

        logger.error(f"CF Calls renegotiate failed: {resp.status_code} {resp.text[:300]}")
        return None
    except Exception as exc:
        logger.error(f"CF Calls renegotiate exception: {exc}")
        return None


def close_session(session_id: str) -> bool:
    """Close/cleanup a Cloudflare Calls session."""
    if not is_configured() or not session_id:
        return False

    try:
        # Cloudflare Calls sessions auto-expire, but we can close tracks
        # There's no explicit delete endpoint; sessions auto-close when all
        # tracks are removed. This is a best-effort cleanup.
        return True
    except Exception as exc:
        logger.error(f"CF Calls close_session exception: {exc}")
        return False


def get_turn_credentials() -> Optional[Dict[str, Any]]:
    """
    Get TURN server credentials from Cloudflare TURN service.

    Returns ICE server config suitable for RTCPeerConnection:
    {
        "iceServers": [
            {"urls": "stun:stun.cloudflare.com:3478"},
            {"urls": "turn:turn.cloudflare.com:3478", "username": "...", "credential": "..."},
            {"urls": "turns:turn.cloudflare.com:5349", "username": "...", "credential": "..."},
        ]
    }
    """
    # If TURN credentials are configured, use the Cloudflare TURN API
    if CF_TURN_KEY_ID and CF_TURN_API_TOKEN:
        try:
            resp = requests.post(
                "https://rtc.live.cloudflare.com/v1/turn/keys/" + CF_TURN_KEY_ID + "/credentials/generate",
                json={"ttl": 86400},  # 24 hour TTL
                headers={
                    "Authorization": f"Bearer {CF_TURN_API_TOKEN}",
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
            if resp.status_code in (200, 201):
                data = resp.json()
                ice_servers = data.get("iceServers", {})
                username = ice_servers.get("username", "")
                credential = ice_servers.get("credential", "")

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
            logger.warning(f"CF TURN credentials request failed: {resp.status_code}")
        except Exception as exc:
            logger.error(f"CF TURN credentials exception: {exc}")

    # Fallback: STUN only (works on same network, may fail across NAT)
    return {
        "iceServers": [
            {"urls": "stun:stun.cloudflare.com:3478"},
            {"urls": "stun:stun.l.google.com:19302"},
        ]
    }

