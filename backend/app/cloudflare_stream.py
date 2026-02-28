"""
Cloudflare Stream Live Input management.

Uses the Cloudflare Stream API to create/manage WHIP/WHEP live inputs
for ultra-low-latency WebRTC streaming.

Env vars required:
    CF_API_TOKEN   – Cloudflare API token with Stream:Edit permission
    CF_ACCOUNT_ID  – Cloudflare account ID
"""

import os
import time
import logging
import requests
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

CF_API_TOKEN = os.getenv("CF_API_TOKEN", "")
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
CF_API_BASE = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/stream"

_headers = {
    "Authorization": f"Bearer {CF_API_TOKEN}",
    "Content-Type": "application/json",
}


def _check_config():
    if not CF_API_TOKEN or not CF_ACCOUNT_ID:
        logger.warning(
            "Cloudflare Stream not configured. Set CF_API_TOKEN and CF_ACCOUNT_ID env vars."
        )
        return False
    return True


def create_live_input(name: str, uid: str = "") -> Optional[Dict[str, Any]]:
    """
    Create a Cloudflare Stream Live Input with automatic recording enabled.

    Returns dict:
        {
            "live_input_uid": str,
            "whip_url": str,       # Camera owner POSTs SDP offer here
            "whep_url": str,       # Viewers POST SDP offer here
            "thumbnail_url": str,  # Live thumbnail JPEG endpoint
            "playback_url": str,   # HLS playback URL (fallback)
        }
    or None on failure.
    """
    if not _check_config():
        return None

    try:
        payload = {
            "meta": {"name": name, "uid": uid},
            "recording": {"mode": "automatic", "timeoutSeconds": 30},
            "deleteRecordingAfterDays": 30,
        }

        resp = requests.post(
            f"{CF_API_BASE}/live_inputs",
            json=payload,
            headers=_headers,
            timeout=15,
        )

        if resp.status_code not in (200, 201):
            logger.error(f"CF create_live_input failed: {resp.status_code} {resp.text[:500]}")
            return None

        data = resp.json()
        if not data.get("success"):
            logger.error(f"CF create_live_input error: {data.get('errors')}")
            return None

        result = data["result"]
        live_input_uid = result["uid"]

        # Cloudflare WHIP/WHEP URLs follow a predictable pattern:
        # WHIP: https://customer-{subdomain}.cloudflarestream.com/{live_input_uid}/webRTC/publish
        # WHEP: https://customer-{subdomain}.cloudflarestream.com/{live_input_uid}/webRTC/play
        # But the proper way is to use the SRT/webRTC URLs from the response
        webrtc = result.get("webRTC", {})
        whip_url = webrtc.get("url", "")

        # If the API returns a webRTC URL, derive WHIP/WHEP from it
        # Cloudflare pattern: the webRTC.url is the WHIP publish URL
        # WHEP is the same base with /webRTC/play instead of /webRTC/publish
        if not whip_url:
            # Construct from known pattern
            whip_url = f"https://customer-{CF_ACCOUNT_ID}.cloudflarestream.com/{live_input_uid}/webRTC/publish"

        # WHEP playback URL
        whep_url = whip_url.replace("/webRTC/publish", "/webRTC/play")

        # Thumbnail URL (Cloudflare generates live thumbnails)
        thumbnail_url = f"https://customer-{CF_ACCOUNT_ID}.cloudflarestream.com/{live_input_uid}/thumbnails/thumbnail.jpg"

        # HLS playback (fallback)
        playback_url = f"https://customer-{CF_ACCOUNT_ID}.cloudflarestream.com/{live_input_uid}/manifest/video.m3u8"

        info = {
            "live_input_uid": live_input_uid,
            "whip_url": whip_url,
            "whep_url": whep_url,
            "thumbnail_url": thumbnail_url,
            "playback_url": playback_url,
            "cf_raw": result,
        }
        logger.info(f"Created CF Live Input {live_input_uid} for '{name}'")
        return info

    except Exception as exc:
        logger.error(f"CF create_live_input exception: {exc}")
        return None


def delete_live_input(live_input_uid: str) -> bool:
    """Delete a Cloudflare Stream Live Input and its recordings."""
    if not _check_config() or not live_input_uid:
        return False

    try:
        resp = requests.delete(
            f"{CF_API_BASE}/live_inputs/{live_input_uid}",
            headers=_headers,
            timeout=10,
        )
        ok = resp.status_code in (200, 204)
        if ok:
            logger.info(f"Deleted CF Live Input {live_input_uid}")
        else:
            logger.error(f"CF delete failed: {resp.status_code} {resp.text[:300]}")
        return ok
    except Exception as exc:
        logger.error(f"CF delete exception: {exc}")
        return False


def get_live_input(live_input_uid: str) -> Optional[Dict[str, Any]]:
    """Fetch details about a specific Live Input."""
    if not _check_config() or not live_input_uid:
        return None

    try:
        resp = requests.get(
            f"{CF_API_BASE}/live_inputs/{live_input_uid}",
            headers=_headers,
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data["result"]
        return None
    except Exception as exc:
        logger.error(f"CF get_live_input exception: {exc}")
        return None


def list_recordings(live_input_uid: str) -> list:
    """List recordings (completed video segments) for a Live Input."""
    if not _check_config() or not live_input_uid:
        return []

    try:
        resp = requests.get(
            f"{CF_API_BASE}/live_inputs/{live_input_uid}/videos",
            headers=_headers,
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("result", [])
        return []
    except Exception as exc:
        logger.error(f"CF list_recordings exception: {exc}")
        return []


def create_clip(
    live_input_uid: str,
    start_time_seconds: float,
    end_time_seconds: float,
    label: str = "alert_clip",
) -> Optional[Dict[str, Any]]:
    """
    Create a clip from a Cloudflare Stream recording.

    Uses the Cloudflare Stream clipping API to extract a segment from
    the recorded stream. Returns clip metadata including download/playback URLs.
    """
    if not _check_config() or not live_input_uid:
        return None

    try:
        # First find the most recent recording for this live input
        recordings = list_recordings(live_input_uid)
        if not recordings:
            logger.warning(f"No recordings found for live input {live_input_uid}")
            return None

        # Use the latest recording
        latest_recording = recordings[0]
        video_uid = latest_recording.get("uid", "")
        if not video_uid:
            return None

        # Cloudflare Stream clip endpoint
        payload = {
            "clippedFromVideoUID": video_uid,
            "startTimeSeconds": max(0, int(start_time_seconds)),
            "endTimeSeconds": int(end_time_seconds),
            "meta": {"label": label},
        }

        resp = requests.post(
            f"{CF_API_BASE}/clip",
            json=payload,
            headers=_headers,
            timeout=15,
        )

        if resp.status_code in (200, 201):
            data = resp.json()
            if data.get("success"):
                clip = data["result"]
                clip_uid = clip.get("uid", "")
                return {
                    "clip_uid": clip_uid,
                    "playback_url": f"https://customer-{CF_ACCOUNT_ID}.cloudflarestream.com/{clip_uid}/manifest/video.m3u8",
                    "download_url": f"https://customer-{CF_ACCOUNT_ID}.cloudflarestream.com/{clip_uid}/downloads/default.mp4",
                    "preview_url": f"https://customer-{CF_ACCOUNT_ID}.cloudflarestream.com/{clip_uid}/thumbnails/thumbnail.jpg",
                    "start_time": start_time_seconds,
                    "end_time": end_time_seconds,
                    "source_video_uid": video_uid,
                }

        logger.error(f"CF create_clip failed: {resp.status_code} {resp.text[:500]}")
        return None

    except Exception as exc:
        logger.error(f"CF create_clip exception: {exc}")
        return None


def get_thumbnail_bytes(thumbnail_url: str) -> Optional[bytes]:
    """
    Fetch the live thumbnail JPEG from Cloudflare.
    Returns raw JPEG bytes or None.
    """
    try:
        resp = requests.get(thumbnail_url, timeout=5)
        if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("image/"):
            return resp.content
        return None
    except Exception:
        return None

