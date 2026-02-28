import os
import requests
import logging
import time
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"

# Cloudflare email worker
EMAIL_WORKER_URL = os.getenv("EMAIL_WORKER_URL", "https://akawa-email-worker.ingeniumstem.workers.dev/send")
EMAIL_WORKER_SECRET = os.getenv("EMAIL_WORKER_SECRET", "akawa-alerts-secret-key-2026")

# Telegram Bot API
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")

# Alert type categories — maps model class names to alert types
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

ALERT_TYPES = ["gun", "knife", "fall", "fight"]


class NotificationManager:
    def __init__(self):
        self.last_alert_time: Dict[str, float] = {}

    def get_user_settings(self, uid: str) -> Dict[str, Any]:
        """Fetch alert configuration from Firebase RTDB."""
        try:
            url = f"{FIREBASE_RTDB_BASE}/alerts_config/{uid}.json"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200 and resp.json():
                return resp.json()
        except Exception as e:
            logger.error(f"Error fetching user alert configs: {e}")
        return {}

    def classify_alert(self, class_name: str) -> str:
        """Map a detection class name to one of the 4 alert types."""
        return ALERT_TYPE_MAP.get(class_name.lower(), "gun")

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
        Dispatch alerts based on per-alert-type configuration.
        Reads the user's alerts_config from Firebase and routes to
        email and/or telegram based on the alert_type settings.
        Implements a 30-second cooldown per user/alert_type unless forced.
        """
        now = time.time()
        alert_key = f"{uid}_{alert_type}_{title}"
        if not force and alert_key in self.last_alert_time:
            if now - self.last_alert_time[alert_key] < 30.0:
                return  # Cooldown active

        self.last_alert_time[alert_key] = now

        settings = self.get_user_settings(uid)
        if not settings:
            logger.info(f"No alert config found for user {uid}")
            return

        # Global channel settings
        email_enabled_global = settings.get("email_enabled", True)
        telegram_enabled_global = settings.get("telegram_enabled", False)
        user_email = settings.get("email", "")
        telegram_id = settings.get("telegram_id", "")

        # Per-alert-type settings
        alert_types_config = settings.get("alert_types", {})
        type_config = alert_types_config.get(alert_type, {})

        # If no per-type config exists, fall back to global settings
        type_email_enabled = type_config.get("email", email_enabled_global)
        type_telegram_enabled = type_config.get("telegram", telegram_enabled_global)
        extra_contacts: List[str] = type_config.get("contacts", [])

        # 1. Email: send to user + extra contacts
        if type_email_enabled and email_enabled_global:
            recipients = []
            if user_email:
                recipients.append(user_email)
            for contact in extra_contacts:
                if contact and contact not in recipients:
                    recipients.append(contact)
            if recipients:
                self.send_email(recipients, title, message)

        # 2. Telegram
        if type_telegram_enabled and telegram_enabled_global and telegram_id and TELEGRAM_BOT_TOKEN:
            self.send_telegram(telegram_id, f"🚨 {title}\n\n{message}")

    def send_alert(
        self,
        uid: str,
        title: str,
        message: str,
        image_bytes: Optional[bytes] = None,
        force: bool = False,
        class_name: str = "weapon",
    ):
        """
        Legacy entry point — classifies the alert and routes to send_typed_alert.
        """
        alert_type = self.classify_alert(class_name)
        self.send_typed_alert(uid, alert_type, title, message, image_bytes, force)

    def send_email(self, recipients: List[str], subject: str, body: str):
        """Send email via Cloudflare Worker."""
        try:
            html_body = f"""
            <div style="font-family: monospace; background: #0a0a0a; color: #00ff41; padding: 24px; border: 2px solid #333;">
                <div style="border-bottom: 2px solid #ff3333; padding-bottom: 12px; margin-bottom: 16px;">
                    <h1 style="color: #ff3333; font-size: 18px; margin: 0;">🚨 AKAWA SECURITY ALERT</h1>
                </div>
                <h2 style="color: #00ff41; font-size: 14px;">{subject}</h2>
                <p style="color: #cccccc; font-size: 12px; line-height: 1.6; white-space: pre-wrap;">{body}</p>
                <div style="border-top: 1px solid #333; margin-top: 16px; padding-top: 12px;">
                    <p style="color: #666; font-size: 10px;">AKAWA_OS // AUTOMATED SECURITY NOTIFICATION</p>
                </div>
            </div>
            """
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
                logger.info(f"Email alert sent to {recipients}")
            else:
                logger.error(f"Email worker returned {resp.status_code}: {resp.text}")
        except Exception as e:
            logger.error(f"Failed to send email alert: {e}")

    def send_telegram(self, chat_id: str, text: str):
        """Send Telegram message via Bot API."""
        try:
            url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
            payload = {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
            }
            resp = requests.post(url, json=payload, timeout=10)
            if resp.status_code == 200:
                logger.info(f"Telegram alert sent to {chat_id}")
            else:
                logger.error(f"Telegram API returned {resp.status_code}: {resp.text}")
        except Exception as e:
            logger.error(f"Failed to send Telegram alert: {e}")


notification_manager = NotificationManager()
