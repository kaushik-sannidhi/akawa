import os
import html
import time
import logging
import requests
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"

EMAIL_WORKER_URL = os.getenv(
    "EMAIL_WORKER_URL",
    "https://akawa-email-worker.kaushik-sannidhi.workers.dev/send",
)
# No hardcoded fallback — if the secret isn't set, email is disabled and
# the missing var is logged once at startup rather than silently using a
# secret that's now in your git history.
EMAIL_WORKER_SECRET = os.getenv("EMAIL_WORKER_SECRET", "")
if not EMAIL_WORKER_SECRET:
    logger.warning(
        "EMAIL_WORKER_SECRET is not set — email alerts will be disabled. "
        "Set the env var to enable notifications."
    )

# ── Alert classification ──────────────────────────────────────────────────────
ALERT_TYPE_MAP: Dict[str, str] = {
    "rifle":    "gun",
    "handgun":  "gun",
    "gun":      "gun",
    "weapon":   "gun",
    "knife":    "knife",
    "violence": "fight",
    "fight":    "fight",
    "brawl":    "fight",
    "fall":     "fall",
}
ALERT_TYPES = ["gun", "knife", "fall", "fight"]

# ── User settings cache ───────────────────────────────────────────────────────
# Settings are cached per user for _SETTINGS_TTL seconds.
# Avoids a Firebase GET on every single alert dispatch.
_SETTINGS_TTL = 120  # seconds — cache for 2 minutes
_settings_cache: Dict[str, Dict] = {}   # uid → {"data": {...}, "expires_at": float}

# ── Cooldown tracking ─────────────────────────────────────────────────────────
_COOLDOWN_SECONDS   = 30
_COOLDOWN_MAX_KEYS  = 2000   # prune when dict exceeds this size


class NotificationManager:
    def __init__(self):
        # Cooldown key: "{uid}_{alert_type}" — NOT including title/confidence
        # so the 30-second window actually fires across repeated detections.
        self._last_alert_time: Dict[str, float] = {}

    # ── User settings (cached) ────────────────────────────────────────────────

    def get_user_settings(self, uid: str) -> Dict[str, Any]:
        """
        Fetch alert config from Firebase, cached for _SETTINGS_TTL seconds.
        Falls back to {} on error so callers can always check .get().
        """
        now = time.time()
        cached = _settings_cache.get(uid)
        if cached and cached["expires_at"] > now:
            return cached["data"]

        try:
            resp = requests.get(
                f"{FIREBASE_RTDB_BASE}/alerts_config/{uid}.json", timeout=5
            )
            if resp.status_code == 200 and resp.json():
                data = resp.json()
                _settings_cache[uid] = {"data": data, "expires_at": now + _SETTINGS_TTL}
                return data
        except Exception as e:
            logger.error(f"Error fetching alert config for {uid}: {e}")

        # Cache empty result briefly to avoid retry storms on Firebase errors
        _settings_cache[uid] = {"data": {}, "expires_at": now + 10}
        return {}

    def invalidate_settings_cache(self, uid: str):
        """Call this if user updates their alert config so next alert uses fresh data."""
        _settings_cache.pop(uid, None)

    # ── Alert classification ──────────────────────────────────────────────────

    def classify_alert(self, class_name: str) -> str:
        """
        Map a detection class name to one of the 4 alert types.
        Returns "unknown" instead of silently defaulting to "gun" so
        misconfigured class names are obvious in logs.
        """
        return ALERT_TYPE_MAP.get(class_name.lower(), "unknown")

    # ── Public entry points ───────────────────────────────────────────────────

    def send_alert(
        self,
        uid: str,
        title: str,
        message: str,
        image_bytes: Optional[bytes] = None,
        force: bool = False,
        class_name: str = "weapon",
    ):
        """Classify the alert by class_name and dispatch via send_typed_alert."""
        alert_type = self.classify_alert(class_name)
        if alert_type == "unknown":
            logger.warning(
                f"Unrecognised class_name '{class_name}' for uid={uid} — "
                f"defaulting alert_type to 'gun'. Add to ALERT_TYPE_MAP if intentional."
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
        """
        Dispatch alerts based on per-alert-type user configuration.

        Cooldown is keyed on "{uid}_{alert_type}" — deliberately excludes the
        title and message so repeated detections of the same threat type within
        30 seconds are correctly suppressed rather than always firing.
        """
        now       = time.time()
        cooldown_key = f"{uid}_{alert_type}"

        if not force:
            last = self._last_alert_time.get(cooldown_key, 0.0)
            if now - last < _COOLDOWN_SECONDS:
                logger.debug(
                    f"Alert suppressed (cooldown) uid={uid} type={alert_type} "
                    f"({int(_COOLDOWN_SECONDS - (now - last))}s remaining)"
                )
                return

        self._last_alert_time[cooldown_key] = now
        self._prune_cooldown_dict()

        settings = self.get_user_settings(uid)
        if not settings:
            logger.info(f"No alert config for uid={uid} — skipping notification")
            return

        email_enabled_global = settings.get("email_enabled", True)
        user_email            = settings.get("email", "")
        alert_types_config    = settings.get("alert_types", {})
        type_config           = alert_types_config.get(alert_type, {})

        type_email_enabled = type_config.get("email", email_enabled_global)
        extra_contacts: List[str] = type_config.get("contacts", [])

        if type_email_enabled and email_enabled_global:
            recipients = []
            if user_email:
                recipients.append(user_email)
            for contact in extra_contacts:
                if contact and contact not in recipients:
                    recipients.append(contact)
            if recipients:
                self._send_email(recipients, title, message)

    # ── Email delivery ────────────────────────────────────────────────────────

    def _send_email(self, recipients: List[str], subject: str, body: str):
        """Send email via Cloudflare Worker. Skipped if secret is not configured."""
        if not EMAIL_WORKER_SECRET:
            logger.warning("Email alert skipped — EMAIL_WORKER_SECRET not set.")
            return

        # Escape user-supplied content before inserting into HTML.
        # Stream names, class names, or confidence values containing
        # <, >, ", & would otherwise break the email or allow injection.
        safe_subject = html.escape(subject)
        safe_body    = html.escape(body)

        html_body = f"""
        <div style="font-family: monospace; background: #0a0a0a; color: #00ff41; padding: 24px; border: 2px solid #333;">
            <div style="border-bottom: 2px solid #ff3333; padding-bottom: 12px; margin-bottom: 16px;">
                <h1 style="color: #ff3333; font-size: 18px; margin: 0;">&#x1F6A8; AKAWA SECURITY ALERT</h1>
            </div>
            <h2 style="color: #00ff41; font-size: 14px;">{safe_subject}</h2>
            <p style="color: #cccccc; font-size: 12px; line-height: 1.6; white-space: pre-wrap;">{safe_body}</p>
            <div style="border-top: 1px solid #333; margin-top: 16px; padding-top: 12px;">
                <p style="color: #666; font-size: 10px;">AKAWA_OS // AUTOMATED SECURITY NOTIFICATION</p>
            </div>
        </div>
        """

        try:
            resp = requests.post(
                EMAIL_WORKER_URL,
                json={
                    "to":      recipients,
                    "subject": f"[AKAWA ALERT] {subject}",
                    "body":    body,
                    "html":    html_body,
                },
                headers={
                    "Content-Type":   "application/json",
                    "X-Worker-Secret": EMAIL_WORKER_SECRET,
                },
                timeout=10,
            )
            if resp.status_code == 200:
                logger.info(f"Email alert sent to {recipients} — {subject}")
            else:
                logger.error(
                    f"Email worker returned {resp.status_code}: {resp.text[:200]}"
                )
        except Exception as e:
            logger.error(f"Failed to send email alert: {e}")

    # ── Housekeeping ──────────────────────────────────────────────────────────

    def _prune_cooldown_dict(self):
        """
        Remove expired cooldown entries when the dict grows large.
        Prevents unbounded memory growth on long-running servers with
        many users or streams.
        """
        if len(self._last_alert_time) < _COOLDOWN_MAX_KEYS:
            return
        now     = time.time()
        cutoff  = now - _COOLDOWN_SECONDS
        expired = [k for k, t in self._last_alert_time.items() if t < cutoff]
        for k in expired:
            del self._last_alert_time[k]
        if expired:
            logger.debug(f"Pruned {len(expired)} expired cooldown entries")


notification_manager = NotificationManager()