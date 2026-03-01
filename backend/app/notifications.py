import html
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"

EMAIL_WORKER_URL = os.getenv(
    "EMAIL_WORKER_URL",
    "https://akawa-email-worker.kaushik-sannidhi.workers.dev/send",
)
EMAIL_WORKER_SECRET = os.getenv("EMAIL_WORKER_SECRET", "")
PUBLIC_BACKEND_URL = os.getenv("PUBLIC_BACKEND_URL", "http://localhost:8000").rstrip("/")

if not EMAIL_WORKER_SECRET:
    logger.warning(
        "EMAIL_WORKER_SECRET is not set; email alerts and report notifications are disabled."
    )

ALERT_TYPE_MAP: Dict[str, str] = {
    "rifle": "gun",
    "handgun": "gun",
    "gun": "gun",
    "weapon": "gun",
    "knife": "knife",
    "violence": "fight",
    "fight": "fight",
    "brawl": "fight",
    "fall": "fall",
}

_SETTINGS_TTL = 120
_settings_cache: Dict[str, Dict[str, Any]] = {}

_COOLDOWN_SECONDS = 30
_COOLDOWN_MAX_KEYS = 2000


class NotificationManager:
    def __init__(self):
        self._last_alert_time: Dict[str, float] = {}

    def get_user_settings(self, uid: str) -> Dict[str, Any]:
        now = time.time()
        cached = _settings_cache.get(uid)
        if cached and cached["expires_at"] > now:
            return cached["data"]

        try:
            resp = requests.get(
                f"{FIREBASE_RTDB_BASE}/alerts_config/{uid}.json",
                timeout=5,
            )
            if resp.status_code == 200 and resp.json():
                data = resp.json()
                _settings_cache[uid] = {"data": data, "expires_at": now + _SETTINGS_TTL}
                return data
        except Exception as exc:
            logger.error(f"Failed fetching alert settings uid={uid}: {exc}")

        _settings_cache[uid] = {"data": {}, "expires_at": now + 10}
        return {}

    def invalidate_settings_cache(self, uid: str):
        _settings_cache.pop(uid, None)

    def classify_alert(self, class_name: str) -> str:
        return ALERT_TYPE_MAP.get((class_name or "").lower(), "unknown")

    def send_alert(
        self,
        uid: str,
        title: str,
        message: str,
        image_bytes: Optional[bytes] = None,
        force: bool = False,
        class_name: str = "weapon",
    ):
        alert_type = self.classify_alert(class_name)
        if alert_type == "unknown":
            logger.warning(
                f"Unknown class_name '{class_name}' for uid={uid}; defaulting to 'gun'."
            )
            alert_type = "gun"
        self.send_typed_alert(uid, alert_type, title, message, image_bytes, force)

    def send_typed_alert(
        self,
        uid: str,
        alert_type: str,
        title: str,
        message: str,
        image_bytes: Optional[bytes] = None,
        force: bool = False,
    ):
        now = time.time()
        cooldown_key = f"{uid}_{alert_type}"

        if not force:
            last = self._last_alert_time.get(cooldown_key, 0.0)
            if now - last < _COOLDOWN_SECONDS:
                logger.debug(
                    f"Alert suppressed by cooldown uid={uid} type={alert_type} "
                    f"({int(_COOLDOWN_SECONDS - (now - last))}s remaining)"
                )
                return

        self._last_alert_time[cooldown_key] = now
        self._prune_cooldown_dict()

        settings = self.get_user_settings(uid)
        if not settings:
            logger.info(f"No alert settings configured for uid={uid}; skipping notification.")
            return

        email_enabled_global = settings.get("email_enabled", True)
        user_email = (settings.get("email") or "").strip()
        type_config = (settings.get("alert_types") or {}).get(alert_type, {})
        type_email_enabled = type_config.get("email", email_enabled_global)
        extra_contacts: List[str] = type_config.get("contacts", [])

        if not (email_enabled_global and type_email_enabled):
            return

        recipients: List[str] = []
        if user_email:
            recipients.append(user_email)
        for contact in extra_contacts:
            if contact and contact not in recipients:
                recipients.append(contact)
        if recipients:
            self._send_email(recipients, title, message)

    def send_report_generated_email(self, uid: str, report: Dict[str, Any]):
        """
        Send a report-generated email if enabled in user settings.
        Uses:
          - email_enabled
          - report_email_enabled
          - report_email_contacts
        """
        settings = self.get_user_settings(uid)
        if not settings:
            return
        if not settings.get("email_enabled", True):
            return
        if not settings.get("report_email_enabled", False):
            return

        recipients: List[str] = []
        primary = (settings.get("email") or "").strip()
        if primary:
            recipients.append(primary)
        for addr in (settings.get("report_email_contacts") or []):
            if addr and addr not in recipients:
                recipients.append(addr)
        if not recipients:
            return

        title = str(report.get("title") or "Security Incident")
        threat = str(report.get("threat_type") or "unknown").upper()
        camera = str(report.get("camera_name") or "Unknown Camera")
        confidence_pct = int(float(report.get("confidence", 0.0)) * 100)
        raw_ts = int(report.get("timestamp") or int(time.time() * 1000))
        ts_ms = int(raw_ts * 1000) if raw_ts < 1_000_000_000_000 else raw_ts
        timestamp_utc = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S UTC"
        )

        pdf_url = self._absolute_asset_url(str(report.get("pdf_url") or ""))
        clip_url = self._absolute_asset_url(str(report.get("clip_url") or ""))
        frame_url = self._absolute_asset_url(str(report.get("frame_url") or ""))

        lines = [
            "An incident report has been generated by AKAWA.",
            "",
            f"Title: {title}",
            f"Threat Type: {threat}",
            f"Camera: {camera}",
            f"Confidence: {confidence_pct}%",
            f"Timestamp: {timestamp_utc}",
            "",
        ]
        if report.get("video_offset_seconds") is not None:
            try:
                lines.append(f"Video Offset: {float(report.get('video_offset_seconds')):.2f}s")
            except Exception:
                pass
        if pdf_url:
            lines.append(f"PDF Report: {pdf_url}")
        if clip_url:
            lines.append(f"Alert Clip: {clip_url}")
        if frame_url:
            lines.append(f"Frame Snapshot: {frame_url}")

        self._send_email(
            recipients=recipients,
            subject=f"Incident Report Generated: {title}",
            body="\n".join(lines),
        )

    def _send_email(self, recipients: List[str], subject: str, body: str):
        if not EMAIL_WORKER_SECRET:
            logger.warning("Email send skipped; EMAIL_WORKER_SECRET not configured.")
            return

        safe_subject = html.escape(subject)
        safe_body = html.escape(body)
        html_body = f"""
        <div style="font-family: monospace; background: #0a0a0a; color: #00ff41; padding: 24px; border: 2px solid #333;">
            <div style="border-bottom: 2px solid #ff3333; padding-bottom: 12px; margin-bottom: 16px;">
                <h1 style="color: #ff3333; font-size: 18px; margin: 0;">AKAWA SECURITY NOTICE</h1>
            </div>
            <h2 style="color: #00ff41; font-size: 14px;">{safe_subject}</h2>
            <p style="color: #cccccc; font-size: 12px; line-height: 1.6; white-space: pre-wrap;">{safe_body}</p>
            <div style="border-top: 1px solid #333; margin-top: 16px; padding-top: 12px;">
                <p style="color: #666; font-size: 10px;">AKAWA_OS // AUTOMATED NOTIFICATION</p>
            </div>
        </div>
        """

        try:
            resp = requests.post(
                EMAIL_WORKER_URL,
                json={
                    "to": recipients,
                    "subject": f"[AKAWA ALERT] {subject}",
                    "body": body,
                    "html": html_body,
                },
                headers={
                    "Content-Type": "application/json",
                    "X-Worker-Secret": EMAIL_WORKER_SECRET,
                },
                timeout=10,
            )
            if resp.status_code == 200:
                logger.info(f"Email sent to {recipients}: {subject}")
            else:
                logger.error(f"Email worker failed {resp.status_code}: {resp.text[:200]}")
        except Exception as exc:
            logger.error(f"Email send exception: {exc}")

    def _absolute_asset_url(self, maybe_url: str) -> str:
        if not maybe_url:
            return ""
        if maybe_url.startswith("http://") or maybe_url.startswith("https://"):
            return maybe_url
        if maybe_url.startswith("/"):
            return f"{PUBLIC_BACKEND_URL}{maybe_url}"
        return f"{PUBLIC_BACKEND_URL}/{maybe_url}"

    def _prune_cooldown_dict(self):
        if len(self._last_alert_time) < _COOLDOWN_MAX_KEYS:
            return
        cutoff = time.time() - _COOLDOWN_SECONDS
        stale = [k for k, t in self._last_alert_time.items() if t < cutoff]
        for key in stale:
            del self._last_alert_time[key]
        if stale:
            logger.debug(f"Pruned {len(stale)} stale cooldown entries")


notification_manager = NotificationManager()
