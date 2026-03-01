import os
import uuid
import cv2
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import json
import base64
import numpy as np
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
from dotenv import load_dotenv

# Load backend/.env before importing app modules that may read env at import time.
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from app.telemetry import telemetry_service
from app.stream_manager import stream_manager, SEQUENCE_LENGTH
import requests
import httpx
import anyio
import subprocess
import time as _time

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app):
    print("[STARTUP] Restoring streams from Firebase...")
    _restore_streams_from_firebase()
    print("[STARTUP] Ready.")
    yield


app = FastAPI(title="Akawa Detection API", lifespan=lifespan)

# ── CORS ──────────────────────────────────────────────────────────────────────
default_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://itsakawa.tech",
    "https://www.itsakawa.tech",
    "https://akawa.vercel.app",
    "https://akawa.onrender.com",
]
env_origins = os.getenv("BACKEND_CORS_ORIGINS", "")
configured_origins = [o.strip() for o in env_origins.split(",") if o.strip()]
allow_origins = configured_origins if configured_origins else default_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_origin_regex=r"https://([a-zA-Z0-9\-]+\.)?(itsakawa\.tech|vercel\.app|akawa\.onrender\.com)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
LIVE_EVENTS_DIR = "live_events"
os.makedirs(LIVE_EVENTS_DIR, exist_ok=True)

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"

# Modal API endpoints
FAST_VISION_URL  = "https://apat7--akawa-vlm-api-fastvisionapi-analyze.modal.run"
AUDIO_DETECT_URL = "https://apat7--akawa-audio-api-reyvazdetector-detect.modal.run"
AUDIO_ANALYZE_URL = "https://apat7--akawa-audio-api-qwen2audiomodel-analyze.modal.run"
VLM_ANALYZE_URL   = "https://apat7--akawa-vlm-api-qwen2vlmodel-analyze.modal.run"

WEAPON_CLASSES = ["gun", "knife"]

# ── Recently-deleted stream guard ─────────────────────────────────────────────
_recently_deleted: Dict[str, float] = {}
_DELETED_COOLDOWN = 30.0


def _mark_deleted(stream_id: str):
    _recently_deleted[stream_id] = _time.time()
    cutoff = _time.time() - _DELETED_COOLDOWN * 2
    for sid in list(_recently_deleted):
        if _recently_deleted[sid] < cutoff:
            del _recently_deleted[sid]


def _is_recently_deleted(stream_id: str) -> bool:
    ts = _recently_deleted.get(stream_id)
    if ts is None:
        return False
    if _time.time() - ts > _DELETED_COOLDOWN:
        del _recently_deleted[stream_id]
        return False
    return True


def _restore_streams_from_firebase(uid_filter: str | None = None):
    try:
        resp = requests.get(f"{FIREBASE_RTDB_BASE}/streams.json", timeout=6)
        if resp.status_code != 200:
            return
        streams_by_user = resp.json() or {}
        if not isinstance(streams_by_user, dict):
            return
        for user_uid, streams_dict in streams_by_user.items():
            if not isinstance(streams_dict, dict):
                continue
            for st_id, st_data in streams_dict.items():
                if not isinstance(st_data, dict):
                    continue
                if stream_manager.get_stream(st_id):
                    continue
                if _is_recently_deleted(st_id):
                    continue
                stream_manager.add_stream(
                    name=st_data.get("name", "Unknown"),
                    stream_type=st_data.get("type", "rtsp"),
                    source=st_data.get("source", "0"),
                    uid=user_uid,
                    model_id=st_data.get("model_id", "latest"),
                    device_id=st_data.get("device_id", ""),
                    stream_id=st_id,
                    skip_ai=(st_data.get("type") == "client_cam"),
                    cf_meeting_id=st_data.get("cf_meeting_id", ""),
                )
                print(f"[RESTORE] {st_id} ({st_data.get('type')}) for {user_uid}")
    except Exception as exc:
        print(f"[RESTORE] Failed: {exc}")


# ═══════════════════════════════════════════════════════════════════════════════
# Detection format helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _normalize_bbox(bbox) -> dict:
    """Normalise bbox to {x1,y1,x2,y2} dict regardless of API shape."""
    if isinstance(bbox, dict):
        return {
            "x1": bbox.get("x1", 0), "y1": bbox.get("y1", 0),
            "x2": bbox.get("x2", 1), "y2": bbox.get("y2", 1),
        }
    if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
        return {"x1": bbox[0], "y1": bbox[1], "x2": bbox[2], "y2": bbox[3]}
    return {"x1": 0, "y1": 0, "x2": 1, "y2": 1}


def _format_detection(d: dict) -> dict:
    """
    Convert a Detection object from the new Modal API into the flat dict
    shape that the frontend and all internal callers expect:
      { class_name, confidence, bbox, detection_type, is_threat }
    
    `is_threat` replaces the old `is_weapon` bool and covers weapons,
    falls, and violent persons — any detection_type that warrants an alert.
    """
    detection_type = d.get("detection_type", "person")
    is_threat = detection_type in ("weapon", "fall", "violent_person")
    return {
        "class_name":     d.get("class_name", "unknown"),
        "confidence":     d.get("confidence", 0.0),
        "bbox":           _normalize_bbox(d.get("bbox", [])),
        "detection_type": detection_type,
        # Keep `is_weapon` as an alias for backward compat with any frontend
        # code that hasn't been updated yet — maps to the same is_threat value.
        "is_weapon":      is_threat,
        "is_threat":      is_threat,
    }


def _parse_fast_vision_response(data: dict) -> Dict[str, Any]:
    """
    Parse a full FastVisionResponse dict from the Modal API.
    Returns a normalised dict with:
      - detections:         List of formatted detection dicts
      - threat_type:        "none" | "weapon" | "violence" | "fall"
      - weapon_confidence:  float
      - violence_confidence: float
      - fall_confidence:    float
    """
    detections = [_format_detection(d) for d in (data.get("detections") or [])]
    per_frame_raw = data.get("per_frame_detections") or {}
    per_frame_formatted = {
        idx: [_format_detection(d) for d in dets]
        for idx, dets in per_frame_raw.items()
    }

    return {
        "detections":           detections,
        "per_frame_detections": per_frame_formatted,
        "threat_type":          data.get("threat_type", "none"),
        "weapon_confidence":    data.get("weapon_confidence", 0.0),
        "violence_confidence":  data.get("violence_confidence", 0.0),
        "fall_confidence":      data.get("fall_confidence", 0.0),
        "raw_brawl_confidence": data.get("raw_brawl_confidence"),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Modal proxy functions
# ═══════════════════════════════════════════════════════════════════════════════

def proxy_fast_vision_sequence(
    frames: List[np.ndarray],
    stream_id: str = "default",
    video_name: str = "live_stream",
    source_type: str = "live",
) -> Dict[str, Any]:
    """
    Encode a list of cv2 frames and POST them to the Modal FastVision
    frame_sequence_b64 endpoint.  Called by stream_manager._ai_loop via
    asyncio.to_thread so it must be synchronous.

    Returns a normalised result dict from _parse_fast_vision_response.
    """
    empty = _parse_fast_vision_response({})
    try:
        encoded = []
        for f in frames:
            ret, buf = cv2.imencode(".jpg", f, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            if ret:
                encoded.append(base64.b64encode(buf).decode("utf-8"))

        if len(encoded) < 2:
            return empty

        resp = requests.post(
            FAST_VISION_URL,
            json={
                "frame_sequence_b64": encoded,
                "video_name":          video_name,
                "source_type":         source_type,
                "stream_id":           stream_id,   # ← enables server-side optical flow continuity
            },
            timeout=15,
        )
        if resp.status_code == 200:
            result = _parse_fast_vision_response(resp.json())
            threat_type = result.get("threat_type", "none")
            dets = result.get("detections") or []
            threat_dets = [d for d in dets if d.get("is_threat")]
            logger.info(
                f"[PROXY] stream={stream_id} threat={threat_type} "
                f"dets={len(dets)} threats={len(threat_dets)} "
                f"weapon_conf={result.get('weapon_confidence', 0):.2f} "
                f"violence_conf={result.get('violence_confidence', 0):.2f} "
                f"fall_conf={result.get('fall_confidence', 0):.2f}"
            )
            return result
        logger.error(f"FastVision sequence returned {resp.status_code}: {resp.text[:200]}")
        return empty
    except Exception as e:
        logger.error(f"proxy_fast_vision_sequence error: {e}")
        return empty


def proxy_fast_vision_frame(
    frame: np.ndarray,
    video_name: str = "live_stream",
    source_type: str = "live",
    stream_id: str = "default",
) -> List[Dict[str, Any]]:
    """
    Single-frame path (WebSocket upload detection, audio event overlays).
    Returns a list of formatted detection dicts.
    """
    try:
        ret, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ret:
            return []
        b64_str = base64.b64encode(buffer).decode("utf-8")
        resp = requests.post(
            FAST_VISION_URL,
            json={
                "frame_b64":   b64_str,
                "video_name":  video_name,
                "source_type": source_type,
                "stream_id":   stream_id,
            },
            timeout=5,
        )
        if resp.status_code == 200:
            return _parse_fast_vision_response(resp.json())["detections"]
        return []
    except Exception as e:
        logger.error(f"proxy_fast_vision_frame error: {e}")
        return []


async def proxy_fast_vision_batch(
    frames: List[np.ndarray],
    video_name: str = "video_batch",
) -> List[List[Dict[str, Any]]]:
    """
    Async batch path used by the SSE /api/analyze endpoint for uploaded videos.
    Sends SEQUENCE_LENGTH frames, maps the response back to per-frame lists.
    """
    empty = [[] for _ in frames]
    try:
        def _encode():
            bufs = []
            for f in frames:
                ret, buf = cv2.imencode(".jpg", f, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
                if ret:
                    bufs.append(base64.b64encode(buf).decode("utf-8"))
            return bufs

        encoded = await anyio.to_thread.run_sync(_encode)
        if len(encoded) < 2:
            return empty

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                FAST_VISION_URL,
                json={
                    "frame_sequence_b64": encoded,
                    "video_name":         video_name,
                    "source_type":        "upload",
                    "stream_id":          f"upload_{video_name}",
                },
                timeout=20.0,
            )

        if resp.status_code != 200:
            return empty

        result      = _parse_fast_vision_response(resp.json())
        threat_type = result["threat_type"]
        detections  = result["detections"]
        batch_out   = [[] for _ in frames]

        if threat_type != "none":
            # Attach all threat detections to the last frame for timeline display.
            # Person bboxes are excluded here — they're not useful on the upload timeline.
            threat_dets = [d for d in detections if d.get("is_threat")]
            if threat_dets:
                batch_out[-1] = threat_dets

        return batch_out
    except Exception as e:
        logger.error(f"proxy_fast_vision_batch error: {e}")
        return empty




# ═══════════════════════════════════════════════════════════════════════════════
# VLM proxy (Qwen2-VL scene description)
# ═══════════════════════════════════════════════════════════════════════════════

class VLMAnalyzeRequest(BaseModel):
    video_b64: str
    prompt: str = ""


@app.post("/api/vlm/analyze")
async def vlm_analyze(req: VLMAnalyzeRequest):
    """Proxy to the Qwen2-VL Modal endpoint for clip-level scene description."""
    try:
        payload: dict = {"video_b64": req.video_b64}
        if req.prompt:
            payload["prompt"] = req.prompt
        resp = requests.post(VLM_ANALYZE_URL, json=payload, timeout=60)
        return resp.json() if resp.status_code == 200 else {"error": resp.text, "text": ""}
    except Exception as e:
        logger.error(f"VLM analyze error: {e}")
        return {"error": str(e), "text": ""}


# ═══════════════════════════════════════════════════════════════════════════════
# Audio endpoints
# ═══════════════════════════════════════════════════════════════════════════════

class AudioRequest(BaseModel):
    audio_b64: str
    prompt: str = ""


@app.post("/api/audio/detect")
async def proxy_audio_detect(req: AudioRequest, stream_id: str = None):
    """Proxy to Reyvaz audio event detection model."""
    try:
        resp = requests.post(AUDIO_DETECT_URL, json={"audio_b64": req.audio_b64}, timeout=60)
        if resp.status_code == 200:
            data = resp.json()
            if stream_id and data.get("triggered"):
                stream = stream_manager.get_stream(stream_id)
                if stream:
                    formatted = []
                    for det in data.get("detections", []):
                        formatted.append({
                            "class_name":     det["class_name"],
                            "confidence":     det["max_confidence"],
                            "bbox":           {"x1": 0.05, "y1": 0.05, "x2": 0.95, "y2": 0.95},
                            "detection_type": "weapon",
                            "is_threat":      True,
                            "is_weapon":      True,
                        })
                    if formatted:
                        payload = json.dumps({
                            "type":        "detections",
                            "detections":  formatted,
                            "threat_type": "weapon",
                            "timestamp":   int(_time.time() * 1000),
                        })
                        stream_manager._broadcast_text(stream, payload)
                        telemetry_service.log_anomaly(
                            f"AUDIO_DETECT_{stream.id[:6]}", stream.uid,
                            threat_type="weapon",
                        )
            return data
        return {"error": resp.text}
    except Exception as e:
        logger.error(f"Audio detection error: {e}")
        return {"error": str(e)}


class FastVisionRequest(BaseModel):
    frame_b64: str
    video_name: Optional[str] = "live_stream"
    source_type: Optional[str] = "live"
    stream_id: Optional[str] = "default"


@app.post("/api/detect")
async def proxy_fast_vision_detect(req: FastVisionRequest):
    """
    Proxy to the lightweight single-frame detection endpoint.
    """
    try:
        url = FAST_VISION_URL.replace("/analyze", "/detect")
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json=req.dict())
            resp.raise_for_status()
            data = resp.json()
            return _parse_fast_vision_response(data)
    except Exception as e:
        traceback.print_exc()
        return {"error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# Health
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/health")
@app.get("/health")
def health_check():
    return {"status": "ok", "api": "akawa-backend"}


# ═══════════════════════════════════════════════════════════════════════════════
# Video upload + analysis
# ═══════════════════════════════════════════════════════════════════════════════

def _transcode_video(input_path: str, output_path: str):
    subprocess.run(
        ["ffmpeg", "-i", input_path,
         "-c:v", "libx264", "-preset", "fast", "-crf", "23",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
         "-y", output_path],
        capture_output=True, check=True,
    )


@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...), uid: str = Form("anonymous")):
    video_id   = str(uuid.uuid4())
    safe_name  = "".join(c if c.isalnum() or c in "._-" else "_" for c in file.filename)
    orig_path  = os.path.join(UPLOAD_DIR, f"{video_id}_orig_{safe_name}")
    final_name = f"{video_id}_{os.path.splitext(safe_name)[0]}.mp4"
    final_path = os.path.join(UPLOAD_DIR, final_name)

    with open(orig_path, "wb") as buf:
        buf.write(await file.read())

    try:
        await anyio.to_thread.run_sync(_transcode_video, orig_path, final_path)
    except Exception as e:
        logger.error(f"Transcoding failed: {e}")
        if safe_name.lower().endswith(".mp4"):
            os.rename(orig_path, final_path)
        else:
            return {"error": f"INGESTION_FAILED: {e}"}
    finally:
        if os.path.exists(final_path) and os.path.exists(orig_path):
            try: os.remove(orig_path)
            except: pass

    cap         = cv2.VideoCapture(final_path)
    fps         = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration    = frame_count / fps if fps > 0 else 0
    width       = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height      = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    telemetry_service._push_syslog(
        f"[INFO] BACKEND INGESTED FORENSIC PAYLOAD {file.filename} (TRANSCODED TO MP4)", uid
    )
    return {
        "video_id": video_id,
        "filename": file.filename,
        "duration": duration,
        "fps": fps,
        "resolution": {"width": width, "height": height},
        "file_url": f"/uploads/{final_name}",
    }


from fastapi.responses import StreamingResponse


@app.get("/api/analyze/{video_id}")
async def analyze_video(video_id: str, uid: str = "anonymous", model_id: str = "latest"):
    """
    Analyse an uploaded video server-side via SSE.
    Sends batches of SEQUENCE_LENGTH frames to the Modal sequence endpoint.
    """
    matching = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(video_id)]
    if not matching:
        return {"error": "Video not found"}

    file_path  = os.path.join(UPLOAD_DIR, matching[0])
    BATCH_SIZE = SEQUENCE_LENGTH   # keep in sync with stream_manager

    async def generate():
        def _get_cap_info():
            cap         = cv2.VideoCapture(file_path)
            fps         = cap.get(cv2.CAP_PROP_FPS) or 30
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            return cap, fps, total_frames

        cap, fps, total_frames = await anyio.to_thread.run_sync(_get_cap_info)
        sample_interval = max(1, int(fps / 10))
        total_samples   = (total_frames + sample_interval - 1) // sample_interval if total_frames > 0 else 0

        yield f"data: {json.dumps({'type': 'start', 'total_frames': total_frames, 'total_samples': total_samples, 'fps': fps})}\n\n"

        frame_idx      = 0
        sample_count   = 0
        batch_frames   = []
        batch_timestamps = []

        while True:
            ret, frame = await anyio.to_thread.run_sync(cap.read)
            if not ret:
                break

            if frame_idx % sample_interval == 0:
                batch_frames.append(frame)
                batch_timestamps.append(round(frame_idx / fps, 3))

                if len(batch_frames) >= BATCH_SIZE:
                    batch_detections = await proxy_fast_vision_batch(batch_frames, video_name=matching[0])

                    for i, ts in enumerate(batch_timestamps):
                        sample_count += 1
                        telemetry_service.log_frames(sample_interval, uid)
                        dets = batch_detections[i]

                        threat_type = "none"
                        if dets:
                            dt = dets[0].get("detection_type", "person")
                            if dt == "weapon":
                                threat_type = "weapon"
                            elif dt == "fall":
                                threat_type = "fall"
                            elif dt == "violent_person":
                                threat_type = "violence"

                        if threat_type != "none":
                            telemetry_service.log_anomaly(
                                "NODE_PREANALYSIS", uid, threat_type=threat_type
                            )

                        progress = sample_count / max(total_samples, 1)
                        yield f"data: {json.dumps({'type': 'frame', 'timestamp': ts, 'detections': dets, 'threat_type': threat_type, 'progress': round(min(progress, 1.0), 3)})}\n\n"

                    batch_frames     = []
                    batch_timestamps = []

            frame_idx += 1
            if frame_idx % 50 == 0:
                await anyio.sleep(0.01)

        # Flush remaining frames
        if len(batch_frames) >= 2:
            batch_detections = await proxy_fast_vision_batch(batch_frames, video_name=matching[0])
            for i, ts in enumerate(batch_timestamps):
                sample_count += 1
                dets = batch_detections[i] if i < len(batch_detections) else []
                threat_type = "none"
                if dets:
                    dt = dets[0].get("detection_type", "person")
                    threat_type = {"weapon": "weapon", "fall": "fall", "violent_person": "violence"}.get(dt, "none")
                if threat_type != "none":
                    telemetry_service.log_anomaly("NODE_PREANALYSIS", uid, threat_type=threat_type)
                progress = sample_count / max(total_samples, 1)
                yield f"data: {json.dumps({'type': 'frame', 'timestamp': ts, 'detections': dets, 'threat_type': threat_type, 'progress': round(min(progress, 1.0), 3)})}\n\n"

        await anyio.to_thread.run_sync(cap.release)
        yield f"data: {json.dumps({'type': 'done', 'total_analyzed': sample_count})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/live-events", StaticFiles(directory=LIVE_EVENTS_DIR), name="live_events")


# ═══════════════════════════════════════════════════════════════════════════════
# Alert persistence
# ═══════════════════════════════════════════════════════════════════════════════

class AlertItem(BaseModel):
    class_name: str
    confidence: float
    startTimestamp: float
    endTimestamp: float
    vlm_analysis: Optional[str] = None


class SaveAlertsRequest(BaseModel):
    uid: str
    video_id: str
    alerts: List[AlertItem]
    send_alerts: bool = False


@app.post("/api/alerts")
async def save_alerts(req: SaveAlertsRequest):
    try:
        import datetime
        alert_data = [
            {
                "class_name":     a.class_name,
                "display_label":  "WEAPON" if a.class_name in WEAPON_CLASSES else a.class_name.upper(),
                "confidence":     a.confidence,
                "startTimestamp": a.startTimestamp,
                "endTimestamp":   a.endTimestamp,
                "vlm_analysis":   a.vlm_analysis,
                "saved_at":       datetime.datetime.now().isoformat(),
            }
            for a in req.alerts
        ]
        resp = requests.put(
            f"{FIREBASE_RTDB_BASE}/alerts/{req.uid}/{req.video_id}.json",
            json=alert_data,
        )
        if req.send_alerts and alert_data:
            from app.notifications import notification_manager
            first = alert_data[0]
            notification_manager.send_alert(
                uid=req.uid,
                title="🚨 Threat Detected in Video Archive!",
                message=f"A {first['display_label']} was detected with {int(first['confidence'] * 100)}% confidence.",
                class_name=first.get("class_name", "weapon"),
            )
        return {"status": "success" if resp.status_code == 200 else "error",
                "count": len(alert_data)}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/alerts/{uid}/{video_id}")
def get_alerts(uid: str, video_id: str):
    try:
        resp = requests.get(f"{FIREBASE_RTDB_BASE}/alerts/{uid}/{video_id}.json")
        data = resp.json()
        if data is None:
            return {"video_id": video_id, "alerts": []}
        if isinstance(data, list):
            return {"video_id": video_id, "alerts": data}
        return {"video_id": video_id, "alerts": list(data.values()) if isinstance(data, dict) else []}
    except Exception as e:
        return {"video_id": video_id, "alerts": [], "error": str(e)}


@app.get("/api/live-events")
def list_live_events(uid: str, stream_id: str = "", class_name: str = "", limit: int = 100):
    if not uid or uid == "anonymous":
        return {"events": []}
    try:
        resp = requests.get(f"{FIREBASE_RTDB_BASE}/live_events/{uid}.json", timeout=6)
        if resp.status_code != 200:
            return {"events": []}
        raw = resp.json() or {}
        if not isinstance(raw, dict):
            return {"events": []}
        events = list(raw.values())
        if stream_id:
            events = [e for e in events if e.get("stream_id") == stream_id]
        if class_name:
            needle = class_name.lower()
            events = [e for e in events if any((c or "").lower() == needle for c in e.get("classes", []))]
        events.sort(key=lambda e: e.get("timestamp", 0), reverse=True)
        return {"events": events[:max(1, min(limit, 500))]}
    except Exception as exc:
        return {"events": [], "error": str(exc)}


# ═══════════════════════════════════════════════════════════════════════════════
# WebSocket — uploaded video detection (frame-by-frame from frontend player)
# ═══════════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/detect/{video_id}")
async def websocket_endpoint(websocket: WebSocket, video_id: str,
                              model: str = "latest", uid: str = "anonymous"):
    try:
        await websocket.accept()
    except Exception as e:
        logger.error(f"[WS DETECT] accept failed: {e}")
        return

    try:
        while True:
            try:
                data = await websocket.receive_text()
            except RuntimeError:
                break

            payload   = json.loads(data)
            if payload.get("type") != "frame":
                continue

            b64_str   = payload.get("image", "")
            timestamp = payload.get("timestamp", 0)

            try:
                encoded   = b64_str.split(",", 1)[1] if "," in b64_str else b64_str
                img_data  = base64.b64decode(encoded)
                nparr     = np.frombuffer(img_data, np.uint8)
                frame     = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                if frame is None:
                    continue

                detections = proxy_fast_vision_frame(
                    frame, video_name=f"ws_{video_id}", source_type="upload"
                )
                telemetry_service.log_frames(1, uid)

                threat_dets = [d for d in detections if d.get("is_threat")]
                if threat_dets:
                    threat_type = threat_dets[0].get("detection_type", "weapon")
                    # Map detection_type to threat_type string
                    if threat_type == "violent_person":
                        threat_type = "violence"
                    telemetry_service.log_anomaly(
                        "NODE_WS_STREAM", uid, threat_type=threat_type
                    )
                    from app.notifications import notification_manager
                    notification_manager.send_alert(
                        uid=uid,
                        title="🚨 Threat Detected in Live Detection Stream!",
                        message=f"A {threat_dets[0].get('class_name', 'threat').upper()} was detected with {int(threat_dets[0].get('confidence', 0) * 100)}% confidence.",
                        class_name=threat_dets[0].get("class_name", "weapon"),
                    )

                await websocket.send_text(json.dumps({
                    "timestamp":  timestamp,
                    "detections": detections,
                    "threat_type": (
                        threat_dets[0].get("detection_type", "weapon")
                        if threat_dets else "none"
                    ),
                }))
            except Exception as e:
                logger.error(f"[WS DETECT] Frame processing error: {e}")

    except WebSocketDisconnect:
        logger.info(f"[WS DETECT] Client disconnected for video {video_id}")
    except Exception as e:
        logger.error(f"[WS DETECT] Unexpected error: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
# Stream management
# ═══════════════════════════════════════════════════════════════════════════════

class StreamCreateRequest(BaseModel):
    name: str
    stream_type: str
    source: str
    uid: str
    model_id: str = "latest"
    device_id: str = ""


@app.get("/api/streams")
async def list_streams(uid: str = "anonymous"):
    _restore_streams_from_firebase()
    return {"streams": stream_manager.list_streams()}


@app.post("/api/streams")
async def create_stream(req: StreamCreateRequest):
    cf_meeting_id = ""
    if req.stream_type == "client_cam":
        try:
            from app.cloudflare_realtime import create_meeting
            meeting = create_meeting(title=req.name)
            if meeting:
                cf_meeting_id = meeting["meeting_id"]
        except Exception as e:
            logger.error(f"[API] CF meeting provisioning failed: {e}")

    stream = stream_manager.add_stream(
        name=req.name,
        stream_type=req.stream_type,
        source=req.source,
        uid=req.uid,
        model_id=req.model_id,
        device_id=req.device_id,
        cf_meeting_id=cf_meeting_id,
    )
    try:
        import datetime
        requests.put(
            f"{FIREBASE_RTDB_BASE}/streams/{req.uid}/{stream.id}.json",
            json={
                "name": req.name, "type": req.stream_type, "source": req.source,
                "uid": req.uid, "model_id": req.model_id, "device_id": req.device_id,
                "created_at": datetime.datetime.now().isoformat(),
                "cf_meeting_id": cf_meeting_id,
            },
        )
    except Exception as e:
        logger.error(f"[API] Firebase persist failed for stream {stream.id}: {e}")

    return {"status": "success", "stream_id": stream.id, "stream": stream.to_dict()}


@app.delete("/api/streams/{stream_id}")
async def delete_stream(stream_id: str, uid: str = "anonymous"):
    _mark_deleted(stream_id)
    stream     = stream_manager.get_stream(stream_id)
    stream_uid = stream.uid if stream else uid

    await stream_manager.remove_stream(stream_id)

    deleted = False
    try:
        resp = requests.delete(
            f"{FIREBASE_RTDB_BASE}/streams/{stream_uid}/{stream_id}.json", timeout=6
        )
        deleted = resp.status_code in (200, 204)
    except Exception as e:
        logger.error(f"[API] Firebase delete failed for {stream_id}: {e}")

    if not deleted or stream_uid == "anonymous":
        try:
            all_resp = requests.get(f"{FIREBASE_RTDB_BASE}/streams.json", timeout=6)
            if all_resp.status_code == 200:
                for fb_uid, fb_streams in (all_resp.json() or {}).items():
                    if isinstance(fb_streams, dict) and stream_id in fb_streams:
                        requests.delete(
                            f"{FIREBASE_RTDB_BASE}/streams/{fb_uid}/{stream_id}.json", timeout=4
                        )
        except Exception as e:
            logger.error(f"[API] Firebase scan-delete failed: {e}")

    return {"status": "success"}


# ═══════════════════════════════════════════════════════════════════════════════
# WebSocket — camera input (frames from device → AI pipeline)
# ═══════════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/stream_in/{stream_id}")
async def websocket_stream_in(websocket: WebSocket, stream_id: str):
    """
    Receives binary JPEG frames from the camera provider.
    Decodes each frame and pushes it into stream._frame_buffer so the
    AI loop can collect SEQUENCE_LENGTH frames and call the sequence API.
    """
    import asyncio as _aio

    await websocket.accept()
    stream = stream_manager.get_stream(stream_id)
    if not stream or stream.type != "client_cam":
        await websocket.close(code=1008)
        return

    logger.info(f"[WS IN] Camera provider connected on stream {stream_id}")
    stream.status = "active"
    stream_manager.ensure_ai_task(stream)

    def _decode_jpeg(jpeg_bytes: bytes):
        np_arr = np.frombuffer(jpeg_bytes, np.uint8)
        return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    try:
        while stream._running:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            jpeg_bytes = message.get("bytes")
            if not jpeg_bytes:
                continue

            # Store latest b64 for legacy viewer broadcast
            stream.latest_frame_b64 = base64.b64encode(jpeg_bytes).decode("utf-8")

            # Decode and push into sequence buffer — this is what triggers inference
            async def _bg(data: bytes):
                frame = await _aio.to_thread(_decode_jpeg, data)
                if frame is not None:
                    stream.latest_frame_cv2 = frame
                    stream.push_frame(frame)   # ← feeds the AI loop batch buffer

            _aio.create_task(_bg(jpeg_bytes))

    except WebSocketDisconnect:
        logger.info(f"[WS IN] Camera provider disconnected from stream {stream_id}")
    except Exception as e:
        logger.error(f"[WS IN] Error on stream {stream_id}: {e}")
    finally:
        if stream_manager.get_stream(stream_id):
            stream.status = "waiting_for_client"


# ═══════════════════════════════════════════════════════════════════════════════
# WebSocket — viewer output (frames + detections)
# ═══════════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/stream_out/{stream_id}")
async def websocket_stream_out(websocket: WebSocket, stream_id: str):
    """Legacy viewer endpoint — frame + detection JSON relay."""
    await websocket.accept()
    stream = stream_manager.get_stream(stream_id)
    if not stream:
        await websocket.close(code=1008)
        return
    stream.viewer_wss.add(websocket)
    try:
        while stream._running and stream_manager.get_stream(stream_id):
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        stream.viewer_wss.discard(websocket)


@app.websocket("/ws/detections/{stream_id}")
async def websocket_detections(websocket: WebSocket, stream_id: str):
    """Detection-only WebSocket for Cloudflare Calls SFU viewers."""
    await websocket.accept()
    stream = stream_manager.get_stream(stream_id)
    if not stream:
        await websocket.close(code=1008)
        return
    stream.detection_wss.add(websocket)
    try:
        while stream._running and stream_manager.get_stream(stream_id):
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("text") == "ping":
                try: await websocket.send_text("pong")
                except Exception: break
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        stream.detection_wss.discard(websocket)


# ═══════════════════════════════════════════════════════════════════════════════
# Cloudflare Realtime Kit
# ═══════════════════════════════════════════════════════════════════════════════

class RealtimeJoinRequest(BaseModel):
    stream_id: str
    participant_name: str = "viewer"
    device_id: str = ""
    role: str = "viewer"   # "publisher" | "viewer"


@app.post("/api/realtime/join")
async def realtime_join(req: RealtimeJoinRequest):
    stream = stream_manager.get_stream(req.stream_id)
    if not stream or not stream.cf_meeting_id:
        return {"error": "Stream not found or Realtime Kit not configured"}

    from app.cloudflare_realtime import add_participant
    pid    = req.device_id or f"anon-{uuid.uuid4().hex[:12]}"
    result = add_participant(
        meeting_id=stream.cf_meeting_id,
        participant_id=pid,
        name=req.participant_name,
        role=req.role,          # ← "publisher" or "viewer", not hardcoded preset
    )
    if not result:
        return {"error": "Failed to add participant"}

    return {
        "auth_token":     result["token"],
        "participant_id": result["participant_id"],
        "meeting_id":     stream.cf_meeting_id,
        "role":           result["role"],
    }


@app.get("/api/turn-credentials")
def get_turn_credentials():
    from app.cloudflare_realtime import get_turn_credentials
    return get_turn_credentials()


# ═══════════════════════════════════════════════════════════════════════════════
# Alert clips
# ═══════════════════════════════════════════════════════════════════════════════

ALERT_CLIPS_DIR_MOUNT = os.path.join(os.path.dirname(__file__), "alert_clips")
os.makedirs(ALERT_CLIPS_DIR_MOUNT, exist_ok=True)
app.mount("/alert-clips", StaticFiles(directory=ALERT_CLIPS_DIR_MOUNT), name="alert_clips")

REPORTS_DIR_MOUNT = os.path.join(os.path.dirname(__file__), "reports")
os.makedirs(REPORTS_DIR_MOUNT, exist_ok=True)
app.mount("/reports", StaticFiles(directory=REPORTS_DIR_MOUNT), name="reports")


@app.get("/api/clips/{uid}")
def list_alert_clips(uid: str, stream_id: str = "", limit: int = 50):
    if not uid or uid == "anonymous":
        return {"clips": []}
    try:
        resp = requests.get(f"{FIREBASE_RTDB_BASE}/alert_clips/{uid}.json", timeout=6)
        if resp.status_code != 200:
            return {"clips": []}
        raw = resp.json() or {}
        if not isinstance(raw, dict):
            return {"clips": []}
        clips = list(raw.values())
        if stream_id:
            clips = [c for c in clips if c.get("stream_id") == stream_id]
        clips.sort(key=lambda c: c.get("timestamp", 0), reverse=True)
        return {"clips": clips[:max(1, min(limit, 200))]}
    except Exception as exc:
        return {"clips": [], "error": str(exc)}


# ═══════════════════════════════════════════════════════════════════════════════
# Incident Reports
# ═══════════════════════════════════════════════════════════════════════════════

class CreateReportRequest(BaseModel):
    uid: str
    title: str
    camera_name: str
    stream_id: str = ""
    threat_type: str
    confidence: float
    vlm_summary: str = ""
    frame_b64: str = ""
    clip_b64: str = ""
    detections: List[Dict[str, Any]] = Field(default_factory=list)
    video_offset_seconds: Optional[float] = None
    timestamp: Optional[int] = None


@app.post("/api/reports")
async def create_report_endpoint(req: CreateReportRequest):
    """Create an incident report from a frontend-submitted alert."""
    from app.report_service import create_report

    frame_bytes = None
    if req.frame_b64:
        try:
            frame_bytes = base64.b64decode(req.frame_b64)
        except Exception:
            pass

    clip_bytes = None
    if req.clip_b64:
        try:
            clip_bytes = base64.b64decode(req.clip_b64)
        except Exception:
            pass

    report = await anyio.to_thread.run_sync(
        lambda: create_report(
            uid=req.uid,
            title=req.title,
            camera_name=req.camera_name,
            threat_type=req.threat_type,
            confidence=req.confidence,
            vlm_summary=req.vlm_summary,
            frame_jpeg_bytes=frame_bytes,
            clip_bytes=clip_bytes,
            detections=req.detections,
            video_offset_seconds=req.video_offset_seconds,
            stream_id=req.stream_id,
            # Server-authoritative event time for report creation.
            timestamp_ms=int(_time.time() * 1000),
        )
    )
    if report:
        return {"status": "success", "report": report}
    raise HTTPException(
        status_code=503,
        detail="Failed to create report. Cloudflare R2 storage is unavailable or upload failed.",
    )


class UpdateReportVLMRequest(BaseModel):
    uid: str
    report_id: str
    vlm_summary: str
    # Optionally regenerate the PDF with the new summary
    title: str = ""
    camera_name: str = ""
    threat_type: str = ""
    confidence: float = 0.0
    timestamp: int = 0
    frame_b64: str = ""


@app.patch("/api/reports/{uid}/{report_id}")
async def update_report_vlm_endpoint(uid: str, report_id: str, req: UpdateReportVLMRequest):
    """Patch a report with VLM analysis (and regenerated PDF)."""
    from app.report_service import update_report_vlm
    from app.report_generator import generate_report_pdf

    pdf_bytes = None
    if req.vlm_summary and req.title:
        frame_bytes = None
        if req.frame_b64:
            try:
                frame_bytes = base64.b64decode(req.frame_b64)
            except Exception:
                pass
        try:
            pdf_bytes = generate_report_pdf(
                title=req.title,
                camera_name=req.camera_name,
                timestamp_ms=req.timestamp or int(_time.time() * 1000),
                threat_type=req.threat_type,
                confidence=req.confidence,
                vlm_summary=req.vlm_summary,
                frame_jpeg_bytes=frame_bytes,
            )
        except Exception as exc:
            logger.error(f"PDF regen failed: {exc}")

    ok = await anyio.to_thread.run_sync(
        lambda: update_report_vlm(uid, report_id, req.vlm_summary, pdf_bytes)
    )
    return {"status": "success" if ok else "error"}


@app.get("/api/reports/{uid}")
def list_reports_endpoint(uid: str, limit: int = 100):
    """List all reports for a user."""
    from app.report_service import list_reports
    if not uid or uid == "anonymous":
        return {"reports": []}
    return {"reports": list_reports(uid, limit)}


@app.get("/api/reports/{uid}/{report_id}")
def get_report_endpoint(uid: str, report_id: str):
    """Get a single report."""
    from app.report_service import get_report
    data = get_report(uid, report_id)
    if data:
        return {"report": data}
    return {"error": "Report not found"}


@app.delete("/api/reports/{uid}/{report_id}")
def delete_report_endpoint(uid: str, report_id: str):
    """Delete a report."""
    from app.report_service import delete_report
    ok = delete_report(uid, report_id)
    return {"status": "success" if ok else "error"}


@app.get("/api/storage/r2-status")
def r2_status():
    """
    Runtime status of Cloudflare R2 integration.
    Useful to confirm report assets are configured to upload to R2.
    """
    from app.r2_storage import (
        is_r2_configured,
        R2_ACCOUNT_ID,
        R2_BUCKET_NAME,
        R2_PUBLIC_URL,
    )
    return {
        "configured": bool(is_r2_configured()),
        "account_id_suffix": (R2_ACCOUNT_ID[-6:] if R2_ACCOUNT_ID else ""),
        "bucket": R2_BUCKET_NAME,
        "public_url": R2_PUBLIC_URL,
        "require_r2_uploads": os.getenv("REQUIRE_R2_REPORT_UPLOADS", "true"),
        "allow_local_fallback": os.getenv("ALLOW_LOCAL_REPORT_FALLBACK", "false"),
    }
