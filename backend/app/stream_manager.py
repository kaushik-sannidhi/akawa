import asyncio
import cv2
import uuid
import time
import json
import logging
import base64
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

        # WebSocket sets -------------------------------------------------------
        # Detection-result subscribers (viewers connect via /ws/stream_out)
        self.detection_wss: Set[WebSocket] = set()

        # WebRTC signaling connections
        self.provider_signal_ws: Optional[WebSocket] = None
        self.viewer_signal_wss: Dict[str, WebSocket] = {}  # peer_id -> ws

        # Legacy viewer WS for fallback frame broadcast (server_cam / rtsp only)
        self.fallback_wss: Set[WebSocket] = set()

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
            "status": self.status,
            "subscriber_count": len(self.detection_wss) + len(self.viewer_signal_wss) + len(self.fallback_wss),
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

        if stream.type in ["rtsp", "server_cam"]:
            stream._running = True
            stream.status = "active"
            stream._capture_task = asyncio.create_task(
                self._capture_and_broadcast_loop(stream))
            stream._ai_task = asyncio.create_task(self._ai_loop(stream))

        elif stream.type == "client_cam":
            stream.status = "waiting_for_client"
            stream._running = True
            # Only start AI loop if a provider will actually be feeding frames.
            # Restored streams from Firebase have no provider yet — skip_ai
            # prevents a busy-loop on latest_frame_cv2 == None.
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

        # Close detection subscribers
        for ws in list(stream.detection_wss):
            await _safe_close(ws)
        stream.detection_wss.clear()

        # Close fallback subscribers
        for ws in list(stream.fallback_wss):
            await _safe_close(ws)
        stream.fallback_wss.clear()

        # Close signaling connections
        if stream.provider_signal_ws:
            await _safe_close(stream.provider_signal_ws)
        for ws in list(stream.viewer_signal_wss.values()):
            await _safe_close(ws)
        stream.viewer_signal_wss.clear()

        # Remove from dict AFTER all connections are closed
        self.streams.pop(stream_id, None)
        logger.info(f"====== STREAM REMOVED: {stream_id} ======")

    def get_stream(self, stream_id: str) -> Optional[Stream]:
        return self.streams.get(stream_id)

    def list_streams(self) -> List[Dict[str, Any]]:
        return [s.to_dict() for s in self.streams.values()]

    # ---------------------------------------------- Server-side capture (RTSP / server_cam)
    async def _capture_and_broadcast_loop(self, stream: Stream):
        source = stream.source
        if stream.type == "server_cam":
            try:
                source = int(source)
            except ValueError:
                pass

        cap = cv2.VideoCapture(source)
        # Minimise internal buffer for lowest latency — always grab freshest frame
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        while stream._running:
            target_time = time.time() + 0.033  # ~30 FPS
            ret, frame = await asyncio.to_thread(cap.read)

            if not ret:
                await asyncio.sleep(0.05)
                continue

            # Resize for performance
            height, width = frame.shape[:2]
            target_width = 800
            if width > target_width:
                scale = target_width / width
                frame = cv2.resize(frame, (target_width, int(height * scale)))

            stream.latest_frame_cv2 = frame  # fresh array each iteration — no copy needed

            # For server_cam / rtsp we broadcast frames via WS (no WebRTC for server-sourced)
            ret_enc, buffer = await asyncio.to_thread(
                cv2.imencode, '.jpg', frame,
                [int(cv2.IMWRITE_JPEG_QUALITY), 65])
            if ret_enc:
                b64_frame = base64.b64encode(buffer).decode('utf-8')
                payload = {
                    "type": "frame",
                    "frame": b64_frame,
                    "detections": stream.latest_detections,
                    "timestamp": int(time.time() * 1000),
                }
                data_str = json.dumps(payload)
                self._broadcast_to_fallback(stream, data_str)

            wait_time = target_time - time.time()
            if wait_time > 0:
                await asyncio.sleep(wait_time)

    # ------------------------------------------------------------------ AI loop
    async def _ai_loop(self, stream: Stream):
        from main import get_detector
        from app.telemetry import telemetry_service
        detector = get_detector(stream.model_id)

        last_det_json: str = ""        # cached serialisation to skip unchanged broadcasts
        last_frame_id: int = 0         # identity check to avoid reprocessing same frame

        while stream._running:
            try:
                frame = stream.latest_frame_cv2
                if frame is None:
                    await asyncio.sleep(0.05)   # no frame yet — tiny wait
                    continue

                # Skip if the exact same ndarray reference (no new frame since last run)
                frame_id = id(frame)
                if frame_id == last_frame_id:
                    await asyncio.sleep(0.02)   # 20 ms back-off, then re-check
                    continue
                last_frame_id = frame_id

                detections = await asyncio.to_thread(
                    detector.process_frame, frame)
                stream.latest_detections = detections
                telemetry_service.log_frames(1, stream.uid)

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

                # Only broadcast when detection payload actually changed
                det_payload = json.dumps({
                    "type": "detections",
                    "detections": detections,
                    "timestamp": int(time.time() * 1000),
                })
                if det_payload != last_det_json or detections:
                    last_det_json = det_payload
                    self._broadcast_to_detection_subs(stream, det_payload)

            except Exception as e:
                logger.error(f"AI Loop error: {e}")
                await asyncio.sleep(1)

    # ---------------------------------------------------------- Broadcast helpers
    def _broadcast_to_detection_subs(self, stream: Stream, data_str: str):
        """Send detection-only JSON to all detection websocket subscribers."""
        for ws in list(stream.detection_wss):
            asyncio.create_task(self._safe_ws_send(ws, data_str, stream.detection_wss))

    def _broadcast_to_fallback(self, stream: Stream, data_str: str):
        """Send full frame+detections to fallback (non-WebRTC) viewers."""
        for ws in list(stream.fallback_wss):
            asyncio.create_task(self._safe_ws_send(ws, data_str, stream.fallback_wss))

    async def _safe_ws_send(self, ws: WebSocket, data_str: str, wss_set: Set[WebSocket]):
        try:
            await ws.send_text(data_str)
        except Exception:
            wss_set.discard(ws)

    # ---------------------------------------------------------- WebRTC Signaling
    async def relay_signal_to_provider(self, stream: Stream, message: dict):
        """Forward a signaling message to the camera provider."""
        if stream.provider_signal_ws:
            try:
                await stream.provider_signal_ws.send_text(json.dumps(message))
            except Exception:
                stream.provider_signal_ws = None

    async def relay_signal_to_viewer(self, stream: Stream, peer_id: str,
                                     message: dict):
        """Forward a signaling message to a specific viewer."""
        ws = stream.viewer_signal_wss.get(peer_id)
        if ws:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                stream.viewer_signal_wss.pop(peer_id, None)

    async def notify_provider_viewer_joined(self, stream: Stream, peer_id: str):
        """Tell the camera provider that a new viewer wants a WebRTC connection."""
        await self.relay_signal_to_provider(stream, {
            "type": "viewer-joined",
            "peerId": peer_id,
        })

    async def notify_provider_viewer_left(self, stream: Stream, peer_id: str):
        """Tell the camera provider a viewer disconnected."""
        await self.relay_signal_to_provider(stream, {
            "type": "viewer-left",
            "peerId": peer_id,
        })


stream_manager = StreamManager()
