import asyncio
import cv2
import uuid
import time
import json
import logging
import numpy as np
from typing import Dict, List, Any, Set, Optional
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class Stream:
    def __init__(self, name: str, stream_type: str, source: str, uid: str,
                 model_id: str = "latest", device_id: str = "",
                 stream_id: str = None):
        self.id = stream_id if stream_id else str(uuid.uuid4())
        self.name = name
        self.type = stream_type
        self.source = source
        self.uid = uid
        self.model_id = model_id
        self.device_id = device_id
        self.created_at = time.time()

        self.status = "starting"
        self.latest_detections = []
        self.latest_frame_cv2 = None

        # PeerJS peer ID of the camera provider (set via REST)
        self.provider_peer_id: str = ""

        # All viewers connect here for detection JSON only (no binary frames)
        self.viewer_wss: Set[WebSocket] = set()

        self._running = False
        self._ai_task = None
        self._capture_task = None

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "source": self.source,
            "uid": self.uid,
            "device_id": self.device_id,
            "subscriber_count": len(self.viewer_wss),
        }


class StreamManager:
    def __init__(self):
        self.streams: Dict[str, Stream] = {}

    # ------------------------------------------------------------------ CRUD
    def add_stream(self, name: str, stream_type: str, source: str, uid: str,
                   model_id: str = "latest", device_id: str = "",
                   stream_id: str = None, skip_ai: bool = False) -> Stream:
        stream = Stream(name, stream_type, source, uid, model_id, device_id, stream_id)
        self.streams[stream.id] = stream
        logger.info(f"====== NEW STREAM CREATED ======")
        logger.info(f"ID: {stream.id} | Name: {name} | Type: {stream_type} | skip_ai: {skip_ai}")

        self._update_telemetry_nodes(uid)

        if stream.type in ["rtsp", "server_cam"]:
            stream._running = True
            stream.status = "active"
            stream._capture_task = asyncio.create_task(
                self._capture_and_broadcast_loop(stream))
            stream._ai_task = asyncio.create_task(self._ai_loop(stream))

        elif stream.type == "client_cam":
            stream.status = "waiting_for_client"
            stream._running = True
            if not skip_ai:
                stream._ai_task = asyncio.create_task(self._ai_loop(stream))

        return stream

    def ensure_ai_task(self, stream: Stream):
        """Start the AI inference loop for a stream if not already running."""
        if stream._ai_task is None or stream._ai_task.done():
            stream._ai_task = asyncio.create_task(self._ai_loop(stream))

    async def remove_stream(self, stream_id: str):
        if stream_id not in self.streams:
            return

        stream = self.streams[stream_id]
        stream._running = False

        if stream._ai_task:
            stream._ai_task.cancel()
        if stream._capture_task:
            stream._capture_task.cancel()

        async def _safe_close(ws):
            try:
                await ws.close()
            except Exception:
                pass

        for ws in list(stream.viewer_wss):
            await _safe_close(ws)
        stream.viewer_wss.clear()

        self.streams.pop(stream_id, None)
        logger.info(f"====== STREAM REMOVED: {stream_id} ======")
        self._update_telemetry_nodes(stream.uid)

    def _update_telemetry_nodes(self, uid: str):
        from app.telemetry import telemetry_service
        count = sum(1 for s in self.streams.values() if s.uid == uid)
        telemetry_service.update_nodes(count, uid)

    def get_stream(self, stream_id: str) -> Optional[Stream]:
        return self.streams.get(stream_id)

    def list_streams(self) -> List[Dict[str, Any]]:
        return [s.to_dict() for s in self.streams.values()]

    # ---------------------------------------------- Server-side capture (RTSP / server_cam)
    async def _capture_and_broadcast_loop(self, stream: Stream):
        """Capture frames for AI inference only — video is NOT relayed (WebRTC handles that)."""
        source = stream.source
        if stream.type == "server_cam":
            try:
                source = int(source)
            except ValueError:
                pass

        cap = cv2.VideoCapture(source)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        while stream._running:
            target_time = time.time() + 0.1  # ~10 FPS for AI (no broadcast needed)
            ret, frame = await asyncio.to_thread(cap.read)

            if not ret:
                await asyncio.sleep(0.05)
                continue

            height, width = frame.shape[:2]
            target_width = 640
            if width > target_width:
                scale = target_width / width
                frame = cv2.resize(frame, (target_width, int(height * scale)))

            stream.latest_frame_cv2 = frame

            wait_time = target_time - time.time()
            if wait_time > 0:
                await asyncio.sleep(wait_time)

    # ------------------------------------------------------------------ AI loop
    async def _ai_loop(self, stream: Stream):
        from main import get_detector
        from app.telemetry import telemetry_service
        detector = get_detector(stream.model_id)

        last_det_json: str = ""
        last_frame_id: int = 0

        while stream._running:
            try:
                frame = stream.latest_frame_cv2
                if frame is None:
                    await asyncio.sleep(0.05)
                    continue

                frame_id = id(frame)
                if frame_id == last_frame_id:
                    await asyncio.sleep(0.02)
                    continue
                last_frame_id = frame_id

                t0 = time.time()
                detections = await asyncio.to_thread(
                    detector.process_frame, frame)
                latency_ms = int((time.time() - t0) * 1000)

                stream.latest_detections = detections
                telemetry_service.log_frames(1, stream.uid)
                telemetry_service.log_latency(latency_ms, stream.uid)

                if any(d.get("is_weapon") for d in detections):
                    telemetry_service.log_anomaly(
                        f"NODE_WS_{stream.id[:6]}", stream.uid)
                    from app.notifications import notification_manager
                    weapon_det = next(d for d in detections if d.get("is_weapon"))
                    notification_manager.send_alert(
                        uid=stream.uid,
                        title=f"🚨 Weapon Detected on Live Stream: {stream.name}",
                        message=f"A {weapon_det.get('class_name', 'weapon').upper()} was detected with {int(weapon_det.get('confidence', 0) * 100)}% confidence."
                    )

                # Broadcast detection results as text JSON to all viewers
                det_payload = json.dumps({
                    "type": "detections",
                    "detections": detections,
                    "timestamp": int(time.time() * 1000),
                })
                if det_payload != last_det_json or detections:
                    last_det_json = det_payload
                    self._broadcast_text(stream, det_payload)

            except Exception as e:
                logger.error(f"AI Loop error: {e}")
                await asyncio.sleep(1)

    # ---------------------------------------------------------- Broadcast helpers
    def _broadcast_text(self, stream: Stream, data_str: str):
        """Send text JSON (detection results) to all viewers."""
        viewers = list(stream.viewer_wss)
        if viewers:
            asyncio.create_task(self._send_all_text(viewers, data_str, stream.viewer_wss))

    async def _send_all_text(self, viewers, data_str: str, wss_set: Set[WebSocket]):
        """Batch-send text data to all viewers concurrently."""
        async def _one(ws: WebSocket):
            try:
                await asyncio.wait_for(ws.send_text(data_str), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            except Exception:
                wss_set.discard(ws)
        await asyncio.gather(*[_one(ws) for ws in viewers])


stream_manager = StreamManager()
