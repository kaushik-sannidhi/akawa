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
from typing import Dict, List, Any, Set, Optional
from fastapi import WebSocket

logger = logging.getLogger(__name__)
FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"
LIVE_EVENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "live_events")
os.makedirs(LIVE_EVENTS_DIR, exist_ok=True)


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
        self.latest_frame_b64: str = ""  # base64 JPEG for viewer broadcast
        self.last_alert_event_ts: int = 0

        # Cloudflare Stream fields
        self.cf_live_input_uid: str = ""
        self.cf_whip_url: str = ""
        self.cf_whep_url: str = ""
        self.cf_thumbnail_url: str = ""
        self.cf_playback_url: str = ""

        # Alert clipping: track ongoing alert window
        self.alert_active: bool = False
        self.alert_start_ts: float = 0.0   # time.time() when alert started
        self.alert_end_ts: float = 0.0
        self.stream_start_ts: float = time.time()  # when the stream was created (for clip offset)

        # All viewers connect here for detection JSON overlay
        self.viewer_wss: Set[WebSocket] = set()
        # Detection-only WS subscribers (lightweight, JSON only)
        self.detection_wss: Set[WebSocket] = set()

        self._running = False
        self._ai_task = None
        self._capture_task = None
        self._broadcast_task = None

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "source": self.source,
            "uid": self.uid,
            "device_id": self.device_id,
            "status": self.status,
            "subscriber_count": len(self.viewer_wss) + len(self.detection_wss),
            "whip_url": self.cf_whip_url,
            "whep_url": self.cf_whep_url,
            "playback_url": self.cf_playback_url,
            "cf_live_input_uid": self.cf_live_input_uid,
        }


class StreamManager:
    def __init__(self):
        self.streams: Dict[str, Stream] = {}

    # ------------------------------------------------------------------ CRUD
    def add_stream(self, name: str, stream_type: str, source: str, uid: str,
                   model_id: str = "latest", device_id: str = "",
                   stream_id: str = None, skip_ai: bool = False,
                   cf_live_input_uid: str = "", cf_whip_url: str = "",
                   cf_whep_url: str = "", cf_thumbnail_url: str = "",
                   cf_playback_url: str = "") -> Stream:
        stream = Stream(name, stream_type, source, uid, model_id, device_id, stream_id)

        # Attach Cloudflare Stream fields
        stream.cf_live_input_uid = cf_live_input_uid
        stream.cf_whip_url = cf_whip_url
        stream.cf_whep_url = cf_whep_url
        stream.cf_thumbnail_url = cf_thumbnail_url
        stream.cf_playback_url = cf_playback_url

        self.streams[stream.id] = stream
        logger.info(f"====== NEW STREAM CREATED ======")
        logger.info(f"ID: {stream.id} | Name: {name} | Type: {stream_type} | skip_ai: {skip_ai} | CF: {bool(cf_live_input_uid)}")

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
            if cf_thumbnail_url and not skip_ai:
                # Use Cloudflare thumbnail polling for AI inference
                stream._ai_task = asyncio.create_task(self._cf_ai_loop(stream))
            elif not skip_ai:
                stream._ai_task = asyncio.create_task(self._ai_loop(stream))
            # Broadcast loop is only needed for legacy WS-based frame relay
            if not cf_whep_url:
                stream._broadcast_task = asyncio.create_task(self._viewer_broadcast_loop(stream))

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
        if stream._broadcast_task:
            stream._broadcast_task.cancel()

        # Cleanup Cloudflare Live Input
        if stream.cf_live_input_uid:
            try:
                from app.cloudflare_stream import delete_live_input
                delete_live_input(stream.cf_live_input_uid)
            except Exception as exc:
                logger.error(f"Failed to delete CF live input {stream.cf_live_input_uid}: {exc}")

        async def _safe_close(ws):
            try:
                await ws.close()
            except Exception:
                pass

        for ws in list(stream.viewer_wss):
            await _safe_close(ws)
        stream.viewer_wss.clear()

        for ws in list(stream.detection_wss):
            await _safe_close(ws)
        stream.detection_wss.clear()

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
        """Capture frames for AI inference and broadcast to viewers for non-client streams."""
        source = stream.source
        if stream.type == "server_cam":
            try:
                source = int(source)
            except ValueError:
                pass

        cap = cv2.VideoCapture(source)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        while stream._running:
            target_time = time.time() + 0.1  # ~10 FPS
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

            # Encode frame for viewer broadcast
            ret_enc, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 65])
            if ret_enc:
                b64_frame = base64.b64encode(buffer).decode("utf-8")
                stream.latest_frame_b64 = b64_frame
                payload = {
                    "type": "frame",
                    "frame": b64_frame,
                    "detections": stream.latest_detections,
                    "timestamp": int(time.time() * 1000),
                }
                self._broadcast_text(stream, json.dumps(payload))

            wait_time = target_time - time.time()
            if wait_time > 0:
                await asyncio.sleep(wait_time)

    # ---------------------------------------------- Viewer broadcast (client_cam)
    async def _viewer_broadcast_loop(self, stream: Stream):
        """
        Broadcast the latest frame + detections to viewers at ~10 FPS.
        For client_cam streams where frames arrive via WebSocket.
        """
        while stream._running:
            try:
                if stream.latest_frame_b64 and stream.viewer_wss:
                    payload = {
                        "type": "frame",
                        "frame": stream.latest_frame_b64,
                        "detections": stream.latest_detections,
                        "timestamp": int(time.time() * 1000),
                    }
                    self._broadcast_text(stream, json.dumps(payload))
                await asyncio.sleep(0.1)  # ~10 FPS
            except Exception as e:
                logger.error(f"Viewer broadcast error: {e}")
                await asyncio.sleep(0.5)

    # ------------------------------------------------------------------ AI loop
    async def _ai_loop(self, stream: Stream):
        from main import proxy_fast_vision_frame
        from app.telemetry import telemetry_service

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
                    proxy_fast_vision_frame, frame)
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
                        title=f"Threat Detected on Live Stream: {stream.name}",
                        message=f"A {weapon_det.get('class_name', 'weapon').upper()} was detected with {int(weapon_det.get('confidence', 0) * 100)}% confidence.",
                        class_name=weapon_det.get("class_name", "weapon"),
                    )
                    self._persist_live_alert_event(stream, frame, detections)

                # Track alert window for clipping
                has_threat = any(d.get("is_weapon") for d in detections)
                self._track_alert_window(stream, has_threat)

                # Broadcast detection-only update (frames are sent by broadcast loop)
                det_payload = json.dumps({
                    "type": "detections",
                    "detections": detections,
                    "timestamp": int(time.time() * 1000),
                })
                if det_payload != last_det_json or detections:
                    last_det_json = det_payload
                    self._broadcast_detections(stream, det_payload)

            except Exception as e:
                logger.error(f"AI Loop error: {e}")
                await asyncio.sleep(1)

    def _persist_live_alert_event(self, stream: Stream, frame, detections: List[Dict[str, Any]]):
        """
        Persist alert evidence (snapshot + detection metadata) for later VLM retrieval.
        """
        now_ms = int(time.time() * 1000)
        if now_ms - stream.last_alert_event_ts < 2500:
            return
        stream.last_alert_event_ts = now_ms

        weapon_dets = [d for d in detections if d.get("is_weapon")]
        if not weapon_dets:
            return

        try:
            event_id = str(uuid.uuid4())
            uid_dir = os.path.join(LIVE_EVENTS_DIR, stream.uid)
            os.makedirs(uid_dir, exist_ok=True)
            image_name = f"{event_id}.jpg"
            image_path = os.path.join(uid_dir, image_name)
            cv2.imwrite(image_path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])

            event = {
                "id": event_id,
                "uid": stream.uid,
                "stream_id": stream.id,
                "stream_name": stream.name,
                "timestamp": now_ms,
                "classes": [d.get("class_name") for d in weapon_dets],
                "top_confidence": max(float(d.get("confidence", 0.0)) for d in weapon_dets),
                "detections": detections,
                "snapshot_url": f"/live-events/{stream.uid}/{image_name}",
            }

            requests.put(
                f"{FIREBASE_RTDB_BASE}/live_events/{stream.uid}/{event_id}.json",
                json=event,
                timeout=4,
            )
        except Exception as exc:
            logger.error(f"Failed to persist live alert event for stream {stream.id}: {exc}")

    # ------------------------------------------------------------------ CF AI loop
    async def _cf_ai_loop(self, stream: Stream):
        """
        AI inference loop for Cloudflare Stream-based streams.
        Periodically fetches live thumbnail from Cloudflare and runs detection.
        """
        from main import proxy_fast_vision_frame
        from app.telemetry import telemetry_service
        from app.cloudflare_stream import get_thumbnail_bytes

        POLL_INTERVAL = 0.5  # 2 FPS for AI inference from thumbnails

        # Wait for the stream to actually start receiving
        await asyncio.sleep(3.0)
        stream.status = "active"

        last_det_json: str = ""
        consecutive_empty = 0

        while stream._running:
            try:
                if not stream.cf_thumbnail_url:
                    await asyncio.sleep(1.0)
                    continue

                # Fetch live thumbnail from Cloudflare
                thumb_bytes = await asyncio.to_thread(
                    get_thumbnail_bytes, stream.cf_thumbnail_url
                )

                if thumb_bytes is None:
                    consecutive_empty += 1
                    if consecutive_empty > 20:
                        stream.status = "waiting_for_client"
                    await asyncio.sleep(POLL_INTERVAL)
                    continue

                consecutive_empty = 0
                stream.status = "active"

                # Decode JPEG to cv2 frame
                np_arr = np.frombuffer(thumb_bytes, np.uint8)
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                if frame is None:
                    await asyncio.sleep(POLL_INTERVAL)
                    continue

                stream.latest_frame_cv2 = frame
                stream.latest_frame_b64 = base64.b64encode(thumb_bytes).decode("utf-8")

                # Run AI inference
                t0 = time.time()
                detections = await asyncio.to_thread(proxy_fast_vision_frame, frame)
                latency_ms = int((time.time() - t0) * 1000)

                stream.latest_detections = detections
                telemetry_service.log_frames(1, stream.uid)
                telemetry_service.log_latency(latency_ms, stream.uid)

                # Check for threats
                has_threat = any(d.get("is_weapon") for d in detections)
                if has_threat:
                    telemetry_service.log_anomaly(
                        f"NODE_CF_{stream.id[:6]}", stream.uid)
                    from app.notifications import notification_manager
                    weapon_det = next(d for d in detections if d.get("is_weapon"))
                    notification_manager.send_alert(
                        uid=stream.uid,
                        title=f"Threat Detected on Live Stream: {stream.name}",
                        message=f"A {weapon_det.get('class_name', 'weapon').upper()} was detected with {int(weapon_det.get('confidence', 0) * 100)}% confidence.",
                        class_name=weapon_det.get("class_name", "weapon"),
                    )
                    self._persist_live_alert_event(stream, frame, detections)

                # Track alert window for clipping
                self._track_alert_window(stream, has_threat)

                # Broadcast detections to all detection WS subscribers
                det_payload = json.dumps({
                    "type": "detections",
                    "detections": detections,
                    "timestamp": int(time.time() * 1000),
                })
                if det_payload != last_det_json or detections:
                    last_det_json = det_payload
                    self._broadcast_detections(stream, det_payload)

                await asyncio.sleep(POLL_INTERVAL)

            except Exception as e:
                logger.error(f"CF AI Loop error: {e}")
                await asyncio.sleep(1)

    def _track_alert_window(self, stream: Stream, has_threat: bool):
        """Track alert start/end for Cloudflare clip generation."""
        now = time.time()

        if has_threat:
            if not stream.alert_active:
                # Alert just started
                stream.alert_active = True
                stream.alert_start_ts = now
            stream.alert_end_ts = now
        else:
            if stream.alert_active:
                # No threat for this frame — check if alert window should close
                # Close after 5 seconds of no threat
                if now - stream.alert_end_ts > 5.0:
                    stream.alert_active = False
                    # Save the alert clip
                    self._save_alert_clip(stream)

    def _save_alert_clip(self, stream: Stream):
        """
        Save an alert clip from Cloudflare Stream recording.
        Called when an alert window closes (threat detected then cleared).
        """
        if not stream.cf_live_input_uid:
            return

        try:
            from app.cloudflare_stream import create_clip

            # Calculate offset from stream start
            start_offset = max(0, stream.alert_start_ts - stream.stream_start_ts - 2.0)  # 2s buffer before
            end_offset = stream.alert_end_ts - stream.stream_start_ts + 2.0  # 2s buffer after

            clip_info = create_clip(
                live_input_uid=stream.cf_live_input_uid,
                start_time_seconds=start_offset,
                end_time_seconds=end_offset,
                label=f"alert_{stream.id}_{int(stream.alert_start_ts)}",
            )

            if clip_info:
                event_id = str(uuid.uuid4())
                event = {
                    "id": event_id,
                    "uid": stream.uid,
                    "stream_id": stream.id,
                    "stream_name": stream.name,
                    "type": "alert_clip",
                    "timestamp": int(stream.alert_start_ts * 1000),
                    "end_timestamp": int(stream.alert_end_ts * 1000),
                    "duration_seconds": round(stream.alert_end_ts - stream.alert_start_ts, 1),
                    "clip": clip_info,
                    "detections_summary": stream.latest_detections[:5],
                }

                requests.put(
                    f"{FIREBASE_RTDB_BASE}/alert_clips/{stream.uid}/{event_id}.json",
                    json=event,
                    timeout=4,
                )
                logger.info(f"Saved alert clip {event_id} for stream {stream.id} "
                           f"({round(end_offset - start_offset, 1)}s)")
            else:
                logger.warning(f"Failed to create clip for stream {stream.id} — "
                             f"recording may not be available yet")

        except Exception as exc:
            logger.error(f"Failed to save alert clip for stream {stream.id}: {exc}")

    # ---------------------------------------------------------- Broadcast helpers
    def _broadcast_detections(self, stream: Stream, data_str: str):
        """Send detection-only JSON to all detection WS subscribers."""
        viewers = list(stream.detection_wss)
        if viewers:
            asyncio.create_task(self._send_all_text(viewers, data_str, stream.detection_wss))
        # Also send to legacy viewer_wss for backward compat
        legacy_viewers = list(stream.viewer_wss)
        if legacy_viewers:
            asyncio.create_task(self._send_all_text(legacy_viewers, data_str, stream.viewer_wss))

    def _broadcast_text(self, stream: Stream, data_str: str):
        """Send text JSON (detection results / frames) to all viewers."""
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
