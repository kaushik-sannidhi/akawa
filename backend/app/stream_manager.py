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
# The new API returns detection_type: "person" | "weapon" | "fall" | "violent_person"
# and a top-level threat_type: "none" | "weapon" | "fall" | "violence"

THREAT_DETECTION_TYPES = {"weapon", "fall", "violent_person"}

def _is_threat_detection(d: dict) -> bool:
    return d.get("detection_type") in THREAT_DETECTION_TYPES

def _is_weapon_detection(d: dict) -> bool:
    return d.get("detection_type") == "weapon"

def _is_fall_detection(d: dict) -> bool:
    return d.get("detection_type") == "fall"

def _is_violence_detection(d: dict) -> bool:
    return d.get("detection_type") == "violent_person"

def _draw_detections(frame, detections: List[dict]):
    """
    Draw aesthetic bounding boxes on a cv2 frame.
    Matches the frontend's visual style:
    - Person: semi-transparent white/gray
    - Weapon: thick red with glow
    - Fall: orange
    - Violence: purple
    """
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
        
        # Color mapping (BGR)
        colors = {
            "person": (200, 200, 200),  # Light gray
            "weapon": (0, 51, 255),     # Red
            "fall": (0, 153, 255),      # Orange
            "violent_person": (255, 51, 204), # Purple
        }
        color = colors.get(det_type, (200, 200, 200))
        
        thickness = 2
        if det_type in THREAT_DETECTION_TYPES or det_type == "violent_person":
            thickness = 3
            # Add a subtle "glow" for threats
            for i in range(1, 3):
                glow_color = tuple(max(0, c - 50) for c in color)
                cv2.rectangle(frame, (x1-i*2, y1-i*2), (x2+i*2, y2+i*2), glow_color, 1)

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, thickness)
        
        # Label background
        (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(frame, (x1, y1 - th - 10), (x1 + tw + 10, y1), color, -1)
        cv2.putText(frame, label, (x1 + 5, y1 - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)

    return frame


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
        self.latest_threat_type: str = "none"   # top-level threat from last API response
        self.latest_frame_cv2 = None
        self.latest_frame_b64: str = ""
        self.last_alert_event_ts: int = 0

        # Cloudflare Calls session ID (used as meeting room)
        self.cf_meeting_id: str = ""

        # Rolling frame buffer for sequence batching (capped at SEQUENCE_LENGTH)
        self._frame_buffer: deque = deque(maxlen=SEQUENCE_LENGTH)

        # Alert clipping
        self.alert_active: bool = False
        self.alert_start_ts: float = 0.0
        self.alert_end_ts: float = 0.0
        self.alert_frames: list = []

        self.viewer_wss: Set[WebSocket] = set()
        self.detection_wss: Set[WebSocket] = set()

        self._running = False
        self._ai_task = None
        self._capture_task = None
        self._broadcast_task = None
        self._active_count = 0  # Number of active viewers/listeners
        self._stop_timer = None

    def push_frame(self, frame) -> bool:
        """
        Append a cv2 frame to the rolling buffer.
        Returns True when the buffer is full and a sequence is ready to send.
        """
        self._frame_buffer.append(frame)
        return len(self._frame_buffer) >= SEQUENCE_LENGTH

    def drain_sequence(self) -> List:
        """
        Return the current buffer contents as a list and clear it.
        Always returns SEQUENCE_LENGTH frames (padded with the last frame if needed).
        """
        frames = list(self._frame_buffer)
        self._frame_buffer.clear()
        # Pad if somehow short (shouldn't happen in normal flow)
        while len(frames) < SEQUENCE_LENGTH:
            frames.append(frames[-1] if frames else np.zeros((480, 640, 3), dtype=np.uint8))
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
            "subscriber_count": len(self.viewer_wss) + len(self.detection_wss),
            "cf_meeting_id": self.cf_meeting_id,
        }


class StreamManager:
    def __init__(self):
        self.streams: Dict[str, Stream] = {}

    # ------------------------------------------------------------------ CRUD
    def add_stream(self, name: str, stream_type: str, source: str, uid: str,
                   model_id: str = "latest", device_id: str = "",
                   stream_id: str = None, skip_ai: bool = False,
                   cf_meeting_id: str = "") -> Stream:
        stream = Stream(name, stream_type, source, uid, model_id, device_id, stream_id)
        stream.cf_meeting_id = cf_meeting_id

        self.streams[stream.id] = stream
        logger.info(f"====== NEW STREAM CREATED ======")
        logger.info(f"ID: {stream.id} | Name: {name} | Type: {stream_type} | skip_ai: {skip_ai} | CF Meeting: {bool(cf_meeting_id)}")

        self._update_telemetry_nodes(uid)

        if stream.type in ["rtsp", "server_cam"]:
            stream.status = "standby"
            # We don't start loops here; they start on viewer join

        elif stream.type == "client_cam":
            stream.status = "waiting_for_client"
            # client_cam AI/broadcast loops are also managed lazily

        return stream

    async def activate_stream(self, stream: Stream):
        """Enable processing loops for this stream if not already running."""
        stream._active_count += 1
        if stream._active_count == 1:
            if stream._stop_timer:
                stream._stop_timer.cancel()
                stream._stop_timer = None

            if not stream._running:
                logger.info(f"Activating stream loops for: {stream.id}")
                stream._running = True
                stream.status = "active"
                if stream.type in ["rtsp", "server_cam"]:
                    stream._capture_task = asyncio.create_task(self._capture_and_broadcast_loop(stream))
                    stream._ai_task = asyncio.create_task(self._ai_loop(stream))
                elif stream.type == "client_cam":
                    stream._ai_task = asyncio.create_task(self._ai_loop(stream))
                    stream._broadcast_task = asyncio.create_task(self._viewer_broadcast_loop(stream))

    async def deactivate_stream(self, stream: Stream):
        """Decrement active count and stop loops after a delay if no one is left."""
        stream._active_count = max(0, stream._active_count - 1)
        if stream._active_count == 0:
            # Wait 30s before stopping to avoid flapping on page refreshes
            if stream._stop_timer:
                stream._stop_timer.cancel()
            stream._stop_timer = asyncio.create_task(self._delayed_stop(stream))

    async def _delayed_stop(self, stream: Stream):
        await asyncio.sleep(30.0)
        if stream._active_count == 0 and stream._running:
            logger.info(f"Deactivating stream loops (inactive): {stream.id}")
            stream._running = False
            stream.status = "standby"
            for task in [stream._ai_task, stream._capture_task, stream._broadcast_task]:
                if task:
                    task.cancel()
            stream._ai_task = None
            stream._capture_task = None
            stream._broadcast_task = None
            # Clear memory-heavy fields
            stream.latest_frame_cv2 = None
            stream.latest_frame_b64 = ""
            stream._frame_buffer.clear()
            stream.alert_frames = []
            import gc
            gc.collect()

    def ensure_ai_task(self, stream: Stream):
        if stream._running and (stream._ai_task is None or stream._ai_task.done()):
            stream._ai_task = asyncio.create_task(self._ai_loop(stream))

    async def remove_stream(self, stream_id: str):
        if stream_id not in self.streams:
            return

        stream = self.streams[stream_id]
        stream._running = False

        for task in [stream._ai_task, stream._capture_task, stream._broadcast_task]:
            if task:
                task.cancel()a

        if stream.cf_meeting_id:
            try:
                from app.cloudflare_realtime import close_meeting
                close_meeting(stream.cf_meeting_id)
            except Exception as exc:
                logger.error(f"Failed to close CF meeting {stream.cf_meeting_id}: {exc}")

        async def _safe_close(ws):
            try: await ws.close()
            except Exception: pass

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

    # ------------------------------------------ Server-side capture (RTSP / server_cam)
    async def _capture_and_broadcast_loop(self, stream: Stream):
        source = stream.source
        if stream.type == "server_cam":
            try:
                source = int(source)
            except ValueError:
                pass

        cap = cv2.VideoCapture(source)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        while stream._running:
            target_time = time.time() + 0.1
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
            # Also push into the sequence buffer so the AI loop picks it up
            stream.push_frame(frame)

            ret_enc, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 65])
            if ret_enc:
                b64_frame = base64.b64encode(buffer).decode("utf-8")
                stream.latest_frame_b64 = b64_frame
                payload = {
                    "type": "frame",
                    "frame": b64_frame,
                    "detections": stream.latest_detections,
                    "threat_type": stream.latest_threat_type,
                    "timestamp": int(time.time() * 1000),
                }
                self._broadcast_text(stream, json.dumps(payload))

            wait_time = target_time - time.time()
            if wait_time > 0:
                await asyncio.sleep(wait_time)

    # ------------------------------------------ Viewer broadcast (client_cam legacy)
    async def _viewer_broadcast_loop(self, stream: Stream):
        while stream._running:
            try:
                if stream.latest_frame_b64 and stream.viewer_wss:
                    payload = {
                        "type": "frame",
                        "frame": stream.latest_frame_b64,
                        "detections": stream.latest_detections,
                        "threat_type": stream.latest_threat_type,
                        "timestamp": int(time.time() * 1000),
                    }
                    self._broadcast_text(stream, json.dumps(payload))
                await asyncio.sleep(0.2)
            except Exception as e:
                logger.error(f"Viewer broadcast error: {e}")
                await asyncio.sleep(0.5)

    # ------------------------------------------------------------------ AI loop
    async def _ai_loop(self, stream: Stream):
        """
        Collects frames into SEQUENCE_LENGTH batches, sends them to the
        FastVision sequence endpoint, then broadcasts the result.

        For client_cam streams: frames arrive via WebSocket and are pushed
        into stream._frame_buffer externally (see push_frame()).
        For rtsp/server_cam:    _capture_and_broadcast_loop pushes frames.
        """
        from main import proxy_fast_vision_sequence
        from app.telemetry import telemetry_service

        last_det_json: str = ""

        while stream._running:
            try:
                # Wait until we have a full sequence ready
                if len(stream._frame_buffer) < SEQUENCE_LENGTH:
                    await asyncio.sleep(0.02)
                    continue

                frames = stream.drain_sequence()

                t0 = time.time()
                # Call sequence API — passes stream.id so the Modal backend
                # can maintain per-stream optical flow state across batches.
                result = await asyncio.to_thread(
                    proxy_fast_vision_sequence,
                    frames,
                    stream.id,          # stream_id for server-side state
                    source_type="live",
                )
                latency_ms = int((time.time() - t0) * 1000)

                # result is the full FastVisionResponse dict from the new API
                detections           = result.get("detections") or []
                per_frame_detections = result.get("per_frame_detections") or {}
                threat_type          = result.get("threat_type", "none")
                has_threat           = threat_type != "none"

                stream.latest_detections  = detections
                stream.latest_threat_type = threat_type
                # Keep latest_frame_cv2 as the last frame of the sequence
                # so _persist_live_alert_event can snapshot it
                stream.latest_frame_cv2   = frames[-1]

                telemetry_service.log_frames(len(frames), stream.uid)
                telemetry_service.log_latency(latency_ms, stream.uid)

                if has_threat:
                    telemetry_service.log_anomaly(
                        f"NODE_WS_{stream.id[:6]}", stream.uid)
                    await self._handle_threat(stream, frames[-1], result)

                # Draw detections on the frame before tracking for alert clips
                # so the boxes are "burnt in" to the recorded clip.
                draw_frame = frames[-1].copy()
                _draw_detections(draw_frame, detections)
                self._track_alert_window(stream, has_threat, draw_frame)

                det_payload = json.dumps({
                    "type": "detections",
                    "detections": detections,
                    "per_frame_detections": per_frame_detections,
                    "threat_type": threat_type,
                    # Pass through model confidence values for frontend debug overlay
                    "weapon_confidence": result.get("weapon_confidence", 0.0),
                    "violence_confidence": result.get("violence_confidence", 0.0),
                    "fall_confidence": result.get("fall_confidence", 0.0),
                    "timestamp": int(time.time() * 1000),
                })
                if det_payload != last_det_json or detections:
                    last_det_json = det_payload
                    self._broadcast_detections(stream, det_payload)

            except Exception as e:
                logger.error(f"AI Loop error (stream {stream.id}): {e}")
                await asyncio.sleep(1)

    async def _handle_threat(self, stream: Stream, frame, result: dict):
        """
        Route threat notifications based on threat_type.
        Handles: weapon, fall, violence.
        """
        from app.notifications import notification_manager

        threat_type        = result.get("threat_type", "none")
        detections         = result.get("detections") or []
        weapon_conf        = result.get("weapon_confidence", 0.0)
        violence_conf      = result.get("violence_confidence", 0.0)
        fall_conf          = result.get("fall_confidence", 0.0)

        if threat_type == "weapon":
            # Find the highest-confidence weapon detection for the message
            weapon_dets = [d for d in detections if _is_weapon_detection(d)]
            best = max(weapon_dets, key=lambda d: d.get("confidence", 0), default=None)
            class_name = best.get("class_name", "weapon") if best else "weapon"
            notification_manager.send_alert(
                uid=stream.uid,
                title=f"Weapon Detected — {stream.name}",
                message=f"A {class_name.upper()} was detected with {int(weapon_conf * 100)}% confidence.",
                class_name=class_name,
            )

        elif threat_type == "violence":
            notification_manager.send_alert(
                uid=stream.uid,
                title=f"Violence Detected — {stream.name}",
                message=f"A physical altercation was detected with {int(violence_conf * 100)}% confidence.",
                class_name="violence",
            )

        elif threat_type == "fall":
            notification_manager.send_alert(
                uid=stream.uid,
                title=f"Fall Detected — {stream.name}",
                message=f"A possible fall was detected with {int(fall_conf * 100)}% confidence.",
                class_name="fall",
            )

        self._persist_live_alert_event(stream, frame, detections, threat_type)

    def _persist_live_alert_event(self, stream: Stream, frame,
                                   detections: List[Dict[str, Any]],
                                   threat_type: str = "weapon"):
        """Persist alert evidence (snapshot + detection metadata) to Firebase."""
        now_ms = int(time.time() * 1000)
        if now_ms - stream.last_alert_event_ts < 2500:
            return
        stream.last_alert_event_ts = now_ms

        threat_dets = [d for d in detections if _is_threat_detection(d)]
        # Allow persistence if there is an explicit threat_type, even if
        # no individual bboxes were found (common for sequence-level violence).
        if not threat_dets and threat_type == "none":
            return

        try:
            event_id = str(uuid.uuid4())
            uid_dir  = os.path.join(LIVE_EVENTS_DIR, stream.uid)
            os.makedirs(uid_dir, exist_ok=True)
            image_name = f"{event_id}.jpg"
            image_path = os.path.join(uid_dir, image_name)
            
            # Draw boxes on the frame before saving
            draw_frame = frame.copy()
            _draw_detections(draw_frame, detections)
            cv2.imwrite(image_path, draw_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])

            event = {
                "id": event_id,
                "uid": stream.uid,
                "stream_id": stream.id,
                "stream_name": stream.name,
                "timestamp": now_ms,
                "threat_type": threat_type,
                "classes": [d.get("class_name") for d in threat_dets] if threat_dets else [threat_type],
                "top_confidence": max(float(d.get("confidence", 0.0)) for d in threat_dets) if threat_dets else 0.85,
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

    # ---------------------------------------------------------- Alert clipping
    def _track_alert_window(self, stream: Stream, has_threat: bool, frame=None):
        now = time.time()

        if has_threat:
            if not stream.alert_active:
                stream.alert_active   = True
                stream.alert_start_ts = now
                stream.alert_frames   = []
            stream.alert_end_ts = now
            if frame is not None:
                try:
                    ret, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
                    if ret:
                        stream.alert_frames.append((now, bytes(buf)))
                    if len(stream.alert_frames) > 150:
                        stream.alert_frames = stream.alert_frames[-150:]
                except Exception:
                    pass
        else:
            if stream.alert_active:
                if now - stream.alert_end_ts > 5.0:
                    stream.alert_active = False
                    self._save_alert_clip_local(stream)
                elif frame is not None:
                    try:
                        ret, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
                        if ret:
                            stream.alert_frames.append((now, bytes(buf)))
                    except Exception:
                        pass

    def _save_alert_clip_local(self, stream: Stream):
        if not stream.alert_frames or len(stream.alert_frames) < 3:
            stream.alert_frames = []
            return

        def _select_representative_frame(alert_frames: list) -> bytes | None:
            """
            Pick a non-black frame for snapshots.
            Chooses the brightest decodable frame from sampled positions.
            """
            if not alert_frames:
                return None
            sample_idx = sorted(
                set(
                    [
                        0,
                        len(alert_frames) // 4,
                        len(alert_frames) // 2,
                        (3 * len(alert_frames)) // 4,
                        len(alert_frames) - 1,
                    ]
                )
            )
            best_bytes = None
            best_score = -1.0
            for idx in sample_idx:
                try:
                    jpg_bytes = alert_frames[idx][1]
                    frame = cv2.imdecode(np.frombuffer(jpg_bytes, np.uint8), cv2.IMREAD_COLOR)
                    if frame is None:
                        continue
                    # Mean grayscale intensity; avoids black/near-black captures.
                    score = float(np.mean(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)))
                    if score > best_score:
                        best_score = score
                        best_bytes = jpg_bytes
                except Exception:
                    continue
            return best_bytes or alert_frames[len(alert_frames) // 2][1]

        try:
            event_id = str(uuid.uuid4())
            uid_dir  = os.path.join(ALERT_CLIPS_DIR, stream.uid)
            os.makedirs(uid_dir, exist_ok=True)
            clip_filename = f"{event_id}.avi"
            clip_path     = os.path.join(uid_dir, clip_filename)

            representative_jpg = _select_representative_frame(stream.alert_frames)
            if not representative_jpg:
                stream.alert_frames = []
                return
            first_frame = cv2.imdecode(
                np.frombuffer(representative_jpg, np.uint8), cv2.IMREAD_COLOR
            )
            if first_frame is None:
                stream.alert_frames = []
                return

            h, w     = first_frame.shape[:2]
            duration = stream.alert_end_ts - stream.alert_start_ts
            fps      = max(1, len(stream.alert_frames) / max(duration, 0.1))

            fourcc = cv2.VideoWriter.fourcc(*"MJPG")
            writer = cv2.VideoWriter(clip_path, fourcc, min(fps, 15), (w, h))
            for _, jpg_bytes in stream.alert_frames:
                frame = cv2.imdecode(np.frombuffer(jpg_bytes, np.uint8), cv2.IMREAD_COLOR)
                if frame is not None:
                    writer.write(frame)
            writer.release()

            clip_info = {
                "id": event_id,
                "uid": stream.uid,
                "stream_id": stream.id,
                "stream_name": stream.name,
                "type": "alert_clip",
                "threat_type": stream.latest_threat_type,
                "timestamp": int(stream.alert_start_ts * 1000),
                "end_timestamp": int(stream.alert_end_ts * 1000),
                "duration_seconds": round(duration, 1),
                "frame_count": len(stream.alert_frames),
                "clip_url": f"/alert-clips/{stream.uid}/{clip_filename}",
                "detections_summary": [
                    d for d in stream.latest_detections[:5]
                    if _is_threat_detection(d)
                ],
            }
            requests.put(
                f"{FIREBASE_RTDB_BASE}/alert_clips/{stream.uid}/{event_id}.json",
                json=clip_info,
                timeout=4,
            )
            logger.info(
                f"Saved alert clip {event_id} for stream {stream.id} "
                f"({round(duration, 1)}s, {len(stream.alert_frames)} frames, "
                f"threat={stream.latest_threat_type})"
            )

            # ── Auto-generate incident report ──────────────────────
            try:
                from app.report_service import create_report
                # Use a representative non-black frame as the report snapshot
                frame_jpeg = representative_jpg
                threat_dets = [d for d in stream.latest_detections[:5] if _is_threat_detection(d)]
                top_conf = max((d.get("confidence", 0.0) for d in threat_dets), default=0.85)

                threat_label_map = {
                    "weapon": "Weapon Detected",
                    "violence": "Violent Altercation Detected",
                    "fall": "Fall / Medical Emergency Detected",
                }
                title = f"{threat_label_map.get(stream.latest_threat_type, stream.latest_threat_type.upper())} — {stream.name}"

                create_report(
                    uid=stream.uid,
                    title=title,
                    camera_name=stream.name,
                    threat_type=stream.latest_threat_type,
                    confidence=top_conf,
                    vlm_summary="",  # VLM analysis will be patched in later via frontend
                    frame_jpeg_bytes=frame_jpeg,
                    clip_path=clip_path,
                    detections=threat_dets,
                    stream_id=stream.id,
                    timestamp_ms=int(time.time() * 1000),
                )
            except Exception as report_exc:
                logger.error(f"[REPORT] Auto-report generation failed for clip {event_id}: {report_exc}")

        except Exception as exc:
            logger.error(f"Failed to save alert clip for stream {stream.id}: {exc}")
        finally:
            stream.alert_frames = []

    # ---------------------------------------------------------- Broadcast helpers
    def _broadcast_detections(self, stream: Stream, data_str: str):
        for ws_set in [stream.detection_wss, stream.viewer_wss]:
            viewers = list(ws_set)
            if viewers:
                asyncio.create_task(self._send_all_text(viewers, data_str, ws_set))

    def _broadcast_text(self, stream: Stream, data_str: str):
        viewers = list(stream.viewer_wss)
        if viewers:
            asyncio.create_task(self._send_all_text(viewers, data_str, stream.viewer_wss))

    async def _send_all_text(self, viewers, data_str: str, wss_set: Set[WebSocket]):
        async def _one(ws: WebSocket):
            try:
                await asyncio.wait_for(ws.send_text(data_str), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            except Exception:
                wss_set.discard(ws)
        await asyncio.gather(*[_one(ws) for ws in viewers])


stream_manager = StreamManager()
