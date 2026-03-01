import asyncio
import cv2
import uuid
import time
import json
import logging
import numpy as np
import base64
import os
import requests
from collections import deque
from typing import Dict, List, Any, Set, Optional
from fastapi import WebSocket

logger = logging.getLogger(__name__)
FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"
LIVE_EVENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "live_events")
os.makedirs(LIVE_EVENTS_DIR, exist_ok=True)
ALERT_CLIPS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "alert_clips")
os.makedirs(ALERT_CLIPS_DIR, exist_ok=True)

# How many frames to batch before calling the sequence API
SEQUENCE_LENGTH = 5

# ─── Detection helpers ────────────────────────────────────────────────────────
THREAT_DETECTION_TYPES = {"weapon", "fall", "violent_person"}

def _is_threat_detection(d: dict) -> bool:
    return d.get("detection_type") in THREAT_DETECTION_TYPES

def _is_weapon_detection(d: dict) -> bool:
    return d.get("detection_type") == "weapon"

def _draw_detections(frame, detections: List[dict]):
    """Draw aesthetic bounding boxes on a cv2 frame."""
    for d in detections:
        bbox = d.get("bbox", {})
        if not bbox: continue
        
        h, w = frame.shape[:2]
        x1, y1 = int(bbox.get("x1", 0) * w), int(bbox.get("y1", 0) * h)
        x2, y2 = int(bbox.get("x2", 1) * w), int(bbox.get("y2", 1) * h)
        
        det_type = d.get("detection_type", "person")
        class_name = d.get("class_name", "unknown").upper()
        conf = int(d.get("confidence", 0) * 100)
        label = f"{class_name} {conf}%"
        
        colors = {
            "person": (200, 200, 200),
            "weapon": (0, 51, 255),
            "fall": (0, 153, 255),
            "violent_person": (255, 51, 204),
        }
        color = colors.get(det_type, (200, 200, 200))
        
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(frame, (x1, y1 - th - 10), (x1 + tw + 10, y1), color, -1)
        cv2.putText(frame, label, (x1 + 5, y1 - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return frame


class Stream:
    def __init__(self, name: str, stream_type: str, source: str, uid: str,
                 model_id: str = "latest", device_id: str = "",
                 stream_id: str = None):
        self.id = stream_id if stream_id else str(uuid.uuid4())
        self.uid = uid
        self.name = name
        self.type = stream_type
        self.source = source
        self.model_id = model_id
        self.device_id = device_id
        self.created_at = time.time()

        self.status = "starting"
        self.latest_detections = []
        self.latest_threat_type: str = "none"
        self.latest_frame_cv2 = None
        self.last_alert_event_ts: int = 0

        self._frame_buffer: deque = deque(maxlen=SEQUENCE_LENGTH)
        self.alert_active: bool = False
        self.alert_start_ts: float = 0.0
        self.alert_end_ts: float = 0.0
        self.alert_frames: list = []

        # Connected WebSocket sets (FastAPI)
        self.viewer_wss: Set[WebSocket] = set()
        self.publisher_wss: Set[WebSocket] = set()
        self.detection_wss: Set[WebSocket] = set()

        self._running = False
        self._ai_task = None
        self._capture_task = None
        self._active_count = 0
        self._stop_timer = None

    def push_frame(self, frame, jpeg_bytes=None):
        self._frame_buffer.append((frame, jpeg_bytes))

    def drain_sequence(self) -> List:
        frames = list(self._frame_buffer)
        self._frame_buffer.clear()
        return frames

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "source": self.source,
            "uid": self.uid,
            "device_id": self.device_id,
            "status": self.status,
            "viewer_count": len(self.viewer_wss),
        }

class StreamManager:
    def __init__(self):
        self.streams: Dict[str, Stream] = {}

    def get_stream(self, stream_id: str) -> Optional[Stream]:
        return self.streams.get(stream_id)

    def add_stream(self, name: str, stream_type: str, source: str, uid: str,
                   model_id: str = "latest", device_id: str = "",
                   stream_id: str = None) -> Stream:
        stream = Stream(name, stream_type, source, uid, model_id, device_id, stream_id)
        self.streams[stream.id] = stream
        stream.status = "waiting_for_client"
        return stream

    async def activate_stream(self, stream: Stream):
        stream._active_count += 1
        if stream._active_count == 1:
            if stream._stop_timer:
                stream._stop_timer.cancel()
                stream._stop_timer = None

            if not stream._running:
                stream._running = True
                stream.status = "active"
                stream._ai_task = asyncio.create_task(self._ai_loop(stream))
                if stream.type in ("rtsp", "server_cam"):
                    stream._capture_task = asyncio.create_task(self._capture_and_broadcast_loop(stream))

    async def deactivate_stream(self, stream: Stream):
        stream._active_count = max(0, stream._active_count - 1)
        if stream._active_count == 0:
            if stream._stop_timer:
                stream._stop_timer.cancel()
            stream._stop_timer = asyncio.create_task(self._delayed_stop(stream))

    async def _delayed_stop(self, stream: Stream):
        await asyncio.sleep(30.0)
        if stream._active_count == 0 and stream._running:
            stream._running = False
            stream.status = "standby"
            if stream._ai_task: stream._ai_task.cancel()
            if stream._capture_task: stream._capture_task.cancel()
            stream.latest_frame_cv2 = None
            stream._frame_buffer.clear()
            stream.alert_frames = []

    async def _capture_and_broadcast_loop(self, stream: Stream):
        source = stream.source
        if source.isdigit(): source = int(source)
        cap = cv2.VideoCapture(source)
        try:
            last_frame_time = 0
            while stream._running:
                now = time.time()
                if now - last_frame_time < (1.0/15.0):
                    await asyncio.sleep(0.01)
                    continue
                
                ret, frame = cap.read()
                if not ret:
                    await asyncio.sleep(1)
                    continue
                
                last_frame_time = now
                h, w = frame.shape[:2]
                if w > 640:
                    frame = cv2.resize(frame, (640, int(h * (640 / w))))
                
                ret, jpeg_buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
                if ret:
                    jpeg_bytes = jpeg_buf.tobytes()
                    stream.latest_frame_cv2 = frame
                    stream.push_frame(frame, jpeg_bytes)
                    await self._broadcast_binary(stream, jpeg_bytes)
        finally:
            cap.release()

    async def _ai_loop(self, stream: Stream):
        from main import proxy_fast_vision_sequence
        while stream._running:
            try:
                if len(stream._frame_buffer) < SEQUENCE_LENGTH:
                    await asyncio.sleep(0.05)
                    continue

                frame_pairs = stream.drain_sequence()
                cv2_frames = [fp[0] for fp in frame_pairs]

                result = await asyncio.to_thread(
                    proxy_fast_vision_sequence,
                    frame_pairs,
                    stream.id,
                    source_type="live",
                )

                detections = result.get("detections") or []
                threat_type = result.get("threat_type", "none")
                stream.latest_detections = detections
                stream.latest_threat_type = threat_type

                if threat_type != "none":
                    await self._handle_threat(stream, cv2_frames[-1], result)

                payload = json.dumps({
                    "type": "detections",
                    "detections": detections,
                    "threat_type": threat_type,
                    "timestamp": int(time.time() * 1000),
                })
                await self._broadcast_text(stream, payload)
            except Exception as e:
                logger.error(f"AI error: {e}")
                await asyncio.sleep(1)

    async def _handle_threat(self, stream: Stream, frame, result: dict):
        from app.notifications import notification_manager
        threat_type = result.get("threat_type")
        notification_manager.send_alert(
            uid=stream.uid,
            title=f"Alert — {stream.name}",
            message=f"Threat detected: {threat_type.upper()}",
            class_name=threat_type,
        )

    def _enqueue_ws_message(self, stream: Stream, ws: WebSocket, is_binary: bool, payload: Any):
        if not hasattr(ws, "_msg_queue"):
            ws._msg_queue = asyncio.Queue(maxsize=30)
            
            async def _worker(client_ws):
                try:
                    while True:
                        msg_is_binary, msg_payload = await client_ws._msg_queue.get()
                        if msg_is_binary:
                            await client_ws.send_bytes(msg_payload)
                        else:
                            await client_ws.send_text(msg_payload)
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass
                finally:
                    # Clean up
                    stream.viewer_wss.discard(client_ws)
                    stream.publisher_wss.discard(client_ws)
                    stream.detection_wss.discard(client_ws)
            
            ws._worker_task = asyncio.create_task(_worker(ws))
        
        # If queue is full, drop the OLDEST frame to stay real-time
        if ws._msg_queue.full():
            try:
                ws._msg_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        
        try:
            ws._msg_queue.put_nowait((is_binary, payload))
        except asyncio.QueueFull:
            pass

    async def _broadcast_text(self, stream: Stream, data: str):
        targets = list(stream.viewer_wss) + list(stream.publisher_wss) + list(stream.detection_wss)
        for ws in targets:
            self._enqueue_ws_message(stream, ws, False, data)

    async def _broadcast_binary(self, stream: Stream, data: bytes):
        targets = list(stream.viewer_wss)
        for ws in targets:
            self._enqueue_ws_message(stream, ws, True, data)

    async def remove_stream(self, stream_id: str):
        if stream_id not in self.streams: return
        s = self.streams[stream_id]
        s._running = False
        if s._ai_task: s._ai_task.cancel()
        if s._capture_task: s._capture_task.cancel()
        for ws in list(s.viewer_wss | s.publisher_wss | s.detection_wss):
            if hasattr(ws, "_worker_task"):
                ws._worker_task.cancel()
            try: await ws.close()
            except: pass
        self.streams.pop(stream_id, None)

    def list_streams(self) -> List[Dict[str, Any]]:
        return [s.to_dict() for s in self.streams.values()]

stream_manager = StreamManager()
