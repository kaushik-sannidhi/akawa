import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage
import requests
import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"

class NotificationManager:
    def __init__(self):
        # SMTP configurations
        self.smtp_server = os.getenv("SMTP_SERVER", "smtp.gmail.com")
        self.smtp_port = int(os.getenv("SMTP_PORT", "587"))
        self.smtp_email = os.getenv("SMTP_EMAIL", "")
        self.smtp_password = os.getenv("SMTP_PASSWORD", "")
        self.last_alert_time: Dict[str, float] = {}

    def get_user_settings(self, uid: str) -> Dict[str, Any]:
        """Fetch alert configuration from Firebase RTDB."""
        try:
            url = f"{FIREBASE_RTDB_BASE}/alerts_config/{uid}.json"
            resp = requests.get(url)
            if resp.status_code == 200 and resp.json():
                return resp.json()
        except Exception as e:
            logger.error(f"Error fetching user alert configs: {e}")
        return {}
        
    def send_alert(self, uid: str, title: str, message: str, image_bytes: Optional[bytes] = None, force: bool = False):
        """Main method to dispatch alerts to all configured channels.
        Implements a 30-second cooldown per user/title unless forced.
        """
        import time
        now = time.time()
        alert_key = f"{uid}_{title}"
        if not force and alert_key in self.last_alert_time:
            if now - self.last_alert_time[alert_key] < 30.0:
                return # Cooldown active
        
        self.last_alert_time[alert_key] = now
        
        settings = self.get_user_settings(uid)
        
        # If alerts are completely disabled for the user, do nothing (unless specifically overriden, but Settings has master toggle)
        if not settings.get("enabled", True):
            logger.info(f"Alerts are disabled for user {uid}")
            return
            
        # 1. Email
        email_addr = settings.get("email")
        if email_addr and self.smtp_email and self.smtp_password:
            self.send_email(email_addr, title, message, image_bytes)
            
        # 2. Discord Webhook
        discord_webhook = settings.get("discord_webhook")
        if discord_webhook:
            self.send_discord_webhook(discord_webhook, title, message)
            
        # 3. WhatsApp (via CallMeBot)
        whatsapp_number = settings.get("whatsapp_number")
        whatsapp_apikey = settings.get("whatsapp_apikey")
        if whatsapp_number and whatsapp_apikey:
            self.send_callmebot_whatsapp(whatsapp_number, whatsapp_apikey, f"{title}\n{message}")
            
        # 4. Signal (via CallMeBot)
        signal_number = settings.get("signal_number")
        signal_apikey = settings.get("signal_apikey")
        if signal_number and signal_apikey:
            self.send_callmebot_signal(signal_number, signal_apikey, f"{title}\n{message}")

    def send_email(self, recipient: str, subject: str, body: str, image_bytes: Optional[bytes] = None):
        try:
            msg = MIMEMultipart()
            msg['From'] = self.smtp_email
            msg['To'] = recipient
            msg['Subject'] = subject

            msg.attach(MIMEText(body, 'plain'))
            
            if image_bytes:
                image = MIMEImage(image_bytes, name="alert_frame.jpg")
                msg.attach(image)

            server = smtplib.SMTP(self.smtp_server, self.smtp_port)
            server.starttls()
            server.login(self.smtp_email, self.smtp_password)
            server.send_message(msg)
            server.quit()
            logger.info(f"Email alert sent to {recipient}")
        except Exception as e:
            logger.error(f"Failed to send email alert: {e}")

    def send_discord_webhook(self, webhook_url: str, title: str, description: str):
        try:
            payload = {
                "embeds": [
                    {
                        "title": title,
                        "description": description,
                        "color": 16711680 # Red color for alerts
                    }
                ]
            }
            requests.post(webhook_url, json=payload)
            logger.info(f"Discord webhook alert sent.")
        except Exception as e:
            logger.error(f"Failed to send Discord webhook alert: {e}")

    def send_callmebot_whatsapp(self, phone: str, apikey: str, text: str):
        try:
            import urllib.parse
            encoded_text = urllib.parse.quote_plus(text)
            url = f"https://api.callmebot.com/whatsapp.php?phone={phone}&text={encoded_text}&apikey={apikey}"
            requests.get(url)
            logger.info(f"WhatsApp alert sent.")
        except Exception as e:
            logger.error(f"Failed to send WhatsApp alert: {e}")

    def send_callmebot_signal(self, phone: str, apikey: str, text: str):
        try:
            import urllib.parse
            encoded_text = urllib.parse.quote_plus(text)
            url = f"https://callmebot.com/signal/send.php?phone={phone}&apikey={apikey}&text={encoded_text}"
            requests.get(url)
            logger.info(f"Signal alert sent.")
        except Exception as e:
            logger.error(f"Failed to send Signal alert: {e}")

notification_manager = NotificationManager()
