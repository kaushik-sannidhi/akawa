import os
import requests
import cv2
import base64
import threading

WEAPON_CLASSES = {"rifle", "handgun", "knife", "weapon"}
MODAL_PREDICT_URL = "https://kaushik-sannidhi--akawa-ai-weaponapi-predict.modal.run"

class WeaponDetector:
    def __init__(self, model_path=None):
        self.lock = threading.Lock()
        print(f"[WeaponDetector] Initialized Modal API Client to {MODAL_PREDICT_URL}")

    @staticmethod
    def list_available_models():
        return [{"id": "latest", "name": "Modal Cloud API"}]

    def _encode_frame(self, frame):
        # Encode cv2 frame to JPEG base64 for HTTP transfer
        _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        b64_str = base64.b64encode(buffer).decode('utf-8')
        return b64_str

    def process_frame(self, frame):
        """
        Sends a single frame to the Modal API.
        """
        try:
            b64_str = self._encode_frame(frame)
            resp = requests.post(
                MODAL_PREDICT_URL,
                json={"image": b64_str, "is_batch": False},
                timeout=5.0
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("detections", [])
            else:
                print(f"[WeaponDetector] Modal API Error {resp.status_code}: {resp.text}")
                return []
        except Exception as e:
            print(f"[WeaponDetector] Request failed: {e}")
            return []

    def process_batch(self, frames):
        """
        Sends multiple frames at once to the Modal API.
        """
        try:
            b64_list = [self._encode_frame(f) for f in frames]
            resp = requests.post(
                MODAL_PREDICT_URL,
                json={"images": b64_list, "is_batch": True},
                timeout=10.0
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("detections", [[]] * len(frames))
            else:
                print(f"[WeaponDetector] Modal API Batch Error {resp.status_code}: {resp.text}")
                return [[]] * len(frames)
        except Exception as e:
            print(f"[WeaponDetector] Request failed: {e}")
            return [[]] * len(frames)

