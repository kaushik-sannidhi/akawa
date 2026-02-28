import os
import uuid
import cv2
import logging
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import json
import base64
import numpy as np
import torch
from pydantic import BaseModel
from typing import List, Dict, Any
from app.telemetry import telemetry_service
from app.stream_manager import stream_manager
import requests

logger = logging.getLogger(__name__)

app = FastAPI(title="Weapon Detection API")

# Setup CORS — allow local dev, itsakawa.tech, Vercel, ingeniumstem, Cloudflare Pages
default_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://itsakawa.tech",
    "https://www.itsakawa.tech",
    "https://akawa.vercel.app",
    "https://backend.ingeniumstem.org",
]
env_origins = os.getenv("BACKEND_CORS_ORIGINS", "")
configured_origins = [o.strip() for o in env_origins.split(",") if o.strip()]
allow_origins = configured_origins if configured_origins else default_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    # Match any subdomain of itsakawa.tech, vercel.app, ingeniumstem.org, or pages.dev
    allow_origin_regex=r"https://([a-zA-Z0-9\-]+\.)?(itsakawa\.tech|vercel\.app|ingeniumstem\.org|pages\.dev)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
LIVE_EVENTS_DIR = "live_events"
os.makedirs(LIVE_EVENTS_DIR, exist_ok=True)

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"

def _restore_streams_from_firebase(uid_filter: str | None = None):
    """
    Ensure in-memory stream_manager includes streams stored in Firebase.
    This keeps stream nodes visible across devices and backend restarts.
    """
    try:
        # Ignore uid_filter to make streams globally visible to everyone
        target_url = f"{FIREBASE_RTDB_BASE}/streams.json"

        resp = requests.get(target_url, timeout=6)
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

                stream_manager.add_stream(
                    name=st_data.get("name", "Unknown"),
                    stream_type=st_data.get("type", "rtsp"),
                    source=st_data.get("source", "0"),
                    uid=user_uid,
                    model_id=st_data.get("model_id", "latest"),
                    device_id=st_data.get("device_id", ""),
                    stream_id=st_id,
                    skip_ai=(st_data.get("type") == "client_cam"),
                )
                print(f"[RESTORE] Restored stream {st_id} ({st_data.get('type', 'unknown')}) for {user_uid}")
    except Exception as exc:
        print(f"[RESTORE] Failed syncing streams from Firebase: {exc}")

# Hardcoded classes for generic alerts until the frontend is updated
WEAPON_CLASSES = ["rifle", "handgun", "knife", "weapon"]

# Modal API Endpoints
FAST_VISION_URL = "https://apat7--akawa-vlm-api-fastvisionapi-analyze.modal.run"
AUDIO_DETECT_URL = "https://apat7--akawa-audio-api-reyvazdetector-detect.modal.run"
AUDIO_ANALYZE_URL = "https://apat7--akawa-audio-api-qwen2audiomodel-analyze.modal.run"

class AudioRequest(BaseModel):
    audio_b64: str
    prompt: str = ""

@app.post("/api/audio/detect")
async def proxy_audio_detect(req: AudioRequest):
    """Proxy purely to the Reyvaz audio event detection model"""
    try:
        resp = requests.post(AUDIO_DETECT_URL, json={"audio_b64": req.audio_b64}, timeout=10)
        return resp.json() if resp.status_code == 200 else {"error": resp.text}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/audio/analyze")
async def proxy_audio_analyze(req: AudioRequest):
    """Proxy to Qwen2-Audio for deep acoustic LLM analysis"""
    try:
        resp = requests.post(AUDIO_ANALYZE_URL, json={"audio_b64": req.audio_b64, "prompt": req.prompt}, timeout=30)
        return resp.json() if resp.status_code == 200 else {"error": resp.text}
    except Exception as e:
        return {"error": str(e)}

def proxy_fast_vision_frame(frame: np.ndarray) -> List[Dict[str, Any]]:
    """Encodes a single OpenCV frame and sends it to the Modal FastVisionAPI."""
    try:
        ret, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ret: return []
        b64_str = base64.b64encode(buffer).decode('utf-8')
        
        resp = requests.post(FAST_VISION_URL, json={"frame_b64": b64_str}, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            return [
                {
                    "class_name": d["class_name"],
                    "confidence": d["confidence"],
                    "bbox": d["bbox"],
                    "is_weapon": d["is_weapon"]
                } for d in data.get("detections", [])
            ]
        return []
    except Exception as e:
        logger.error(f"Error proxying frame to Modal FastVisionAPI: {e}")
        return []

def proxy_fast_vision_batch(frames: List[np.ndarray]) -> List[List[Dict[str, Any]]]:
    """Sends a sequence of frames for TwoStream evaluation. Optionally processes 1 YOLO frame."""
    try:
        encoded_frames = []
        for f in frames:
            ret, buf = cv2.imencode('.jpg', f, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
            if ret:
                encoded_frames.append(base64.b64encode(buf).decode('utf-8'))
                
        if len(encoded_frames) < 2:
            return [[] for _ in frames]
            
        resp = requests.post(FAST_VISION_URL, json={"frame_sequence_b64": encoded_frames}, timeout=10)
        
        # We process batches mainly for TwoStream. For YOLO we just grab a generic result 
        # for the middle frame for demonstration, or return empty tracking boxes since 
        # Modal TwoStream batch doesn't return YOLO boxes right now.
        batch_results = [[] for _ in frames]
        if resp.status_code == 200:
            data = resp.json()
            if data.get("violence_detected"):
                # Put a fake bounding box representing violence on the last frame
                # to trigger the frontend UI
                batch_results[-1] = [{
                    "class_name": "violence",
                    "confidence": data.get("sequence_violence_confidence", 1.0),
                    "bbox": [0, 0, 1, 1], # Full screen generic box
                    "is_weapon": True # Trigger existing frontend logic
                }]
        return batch_results
    except Exception as e:
        logger.error(f"Error proxying batch to Modal FastVisionAPI: {e}")
        return [[] for _ in frames]


@app.get("/api/health")
def health_check():
    """Simple health endpoint for tunnel / load-balancer probes."""
    return {
        "status": "ok",
        "api": "akawa-backend"
    }


@app.get("/health")
def root_health_check():
    """Standard top-level health endpoint."""
    return health_check()


@app.on_event("startup")
async def preload_model():
    print("[STARTUP] Restoring streams from Firebase...")
    _restore_streams_from_firebase()
    print("[STARTUP] Ready to proxy to Modal FastVisionAPI!")

@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...), uid: str = Form("anonymous")):
    video_id = str(uuid.uuid4())
    file_path = os.path.join(UPLOAD_DIR, f"{video_id}_{file.filename}")

    with open(file_path, "wb") as buffer:
        buffer.write(await file.read())

    # Get video info
    cap = cv2.VideoCapture(file_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps if fps > 0 else 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    telemetry_service._push_syslog(f"[INFO] BACKEND INGESTED FORENSIC PAYLOAD {file.filename}", uid)

    return {
        "video_id": video_id,
        "filename": file.filename,
        "duration": duration,
        "fps": fps,
        "resolution": {"width": width, "height": height},
        "file_url": f"/uploads/{video_id}_{file.filename}",
    }


from fastapi.responses import StreamingResponse

@app.get("/api/analyze/{video_id}")
async def analyze_video(video_id: str, uid: str = "anonymous", model_id: str = "latest"):
    """
    Pre-analyzes the entire uploaded video server-side using the Modal FastVisionAPI.
    Streams results via Server-Sent Events (SSE).
    """
    matching = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(video_id)]
    if not matching:
        return {"error": "Video not found"}

    file_path = os.path.join(UPLOAD_DIR, matching[0])

    BATCH_SIZE = 20  # FastVisionAPI (TwoStream) expects 20 frames for optical flow sequence

    def generate():
        cap = cv2.VideoCapture(file_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        # We will sample frames for the batch sequence
        sample_interval = max(1, int(fps / 10))
        total_samples = total_frames // sample_interval

        yield f"data: {json.dumps({'type': 'start', 'total_frames': total_frames, 'total_samples': total_samples, 'fps': fps})}\n\n"

        frame_idx = 0
        sample_count = 0
        batch_frames = []
        batch_timestamps = []

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % sample_interval == 0:
                batch_frames.append(frame)
                batch_timestamps.append(round(frame_idx / fps, 3))

                # When batch is full, send to Modal FastVisionAPI
                if len(batch_frames) >= BATCH_SIZE:
                    batch_detections = proxy_fast_vision_batch(batch_frames)

                    for ts, dets in zip(batch_timestamps, batch_detections):
                        sample_count += 1
                        telemetry_service.log_frames(sample_interval, uid)
                        if any(d.get("is_weapon") for d in dets):
                            telemetry_service.log_anomaly("NODE_PREANALYSIS", uid)

                        progress = sample_count / max(total_samples, 1)
                        yield f"data: {json.dumps({'type': 'frame', 'timestamp': ts, 'detections': dets, 'progress': round(progress, 3)})}\n\n"

                    # Keep a sliding window for TwoStream by dropping half the batch,
                    # or clear entirely to save API calls. Clearing entirely for speed.
                    batch_frames = []
                    batch_timestamps = []

            frame_idx += 1

        # Process remaining frames if we have at least 2 for optical flow
        if len(batch_frames) >= 2:
            batch_detections = proxy_fast_vision_batch(batch_frames)
            for ts, dets in zip(batch_timestamps, batch_detections):
                sample_count += 1
                progress = sample_count / max(total_samples, 1)
                if any(d.get("is_weapon") for d in dets):
                    telemetry_service.log_anomaly("NODE_PREANALYSIS", uid)
                yield f"data: {json.dumps({'type': 'frame', 'timestamp': ts, 'detections': dets, 'progress': round(progress, 3)})}\n\n"

        cap.release()
        yield f"data: {json.dumps({'type': 'done', 'total_analyzed': sample_count})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/live-events", StaticFiles(directory=LIVE_EVENTS_DIR), name="live_events")


# ==================== Firebase Alert Persistence ====================


class AlertItem(BaseModel):
    class_name: str
    confidence: float
    startTimestamp: float
    endTimestamp: float


class SaveAlertsRequest(BaseModel):
    uid: str
    video_id: str
    alerts: List[AlertItem]
    send_alerts: bool = False


@app.post("/api/alerts")
async def save_alerts(req: SaveAlertsRequest):
    """Save weapon alerts to Firebase RTDB under alerts/{uid}/{video_id}."""
    try:
        alert_data = []
        for a in req.alerts:
            alert_data.append({
                "class_name": a.class_name,
                "display_label": "WEAPON" if a.class_name in WEAPON_CLASSES else a.class_name.upper(),
                "confidence": a.confidence,
                "startTimestamp": a.startTimestamp,
                "endTimestamp": a.endTimestamp,
                "saved_at": __import__("datetime").datetime.now().isoformat(),
            })

        url = f"{FIREBASE_RTDB_BASE}/alerts/{req.uid}/{req.video_id}.json"
        resp = requests.put(url, json=alert_data)
        
        if req.send_alerts and alert_data:
            from app.notifications import notification_manager
            first_alert = alert_data[0]
            notification_manager.send_alert(
                uid=req.uid,
                title="🚨 Threat Detected in Video Archive!",
                message=f"A {first_alert['display_label']} was detected with {int(first_alert['confidence'] * 100)}% confidence.",
                class_name=first_alert.get("class_name", "weapon"),
            )

        if resp.status_code == 200:
            return {"status": "success", "count": len(alert_data)}
        else:
            return {"status": "error", "message": resp.text}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/alerts/{uid}/{video_id}")
def get_alerts(uid: str, video_id: str):
    """Retrieve saved alerts from Firebase RTDB for a specific user + video."""
    try:
        url = f"{FIREBASE_RTDB_BASE}/alerts/{uid}/{video_id}.json"
        resp = requests.get(url)
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
    """
    Return persisted live-alert events for later VLM retrieval / audit.
    """
    if not uid or uid == "anonymous":
        return {"events": []}

    try:
        url = f"{FIREBASE_RTDB_BASE}/live_events/{uid}.json"
        resp = requests.get(url, timeout=6)
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
            events = [
                e for e in events
                if any((c or "").lower() == needle for c in e.get("classes", []))
            ]

        events.sort(key=lambda e: e.get("timestamp", 0), reverse=True)
        return {"events": events[: max(1, min(limit, 500))]}
    except Exception as exc:
        return {"events": [], "error": str(exc)}


# ==================== WebSocket Detection Endpoint (for uploaded video) ====================


@app.websocket("/ws/detect/{video_id}")
async def websocket_endpoint(websocket: WebSocket, video_id: str, model: str = "latest", uid: str = "anonymous"):
    print(f"\n[WS DETECT] Connection request for video {video_id} using model {model}")
    try:
        await websocket.accept()
    except Exception as e:
        print(f"[WS DETECT] Failed to accept WebSocket: {e}")
        return
    print(f"[WS DETECT] Accepted connection for video {video_id}")

    try:
        while True:
            try:
                data = await websocket.receive_text()
            except RuntimeError:
                break

            payload = json.loads(data)

            if payload.get("type") == "frame":
                b64_str = payload.get("image", "")
                timestamp = payload.get("timestamp", 0)

                try:
                    if "," in b64_str:
                        header, encoded = b64_str.split(",", 1)
                    else:
                        encoded = b64_str
                    img_data = base64.b64decode(encoded)
                    nparr = np.frombuffer(img_data, np.uint8)
                    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                    if frame is not None:
                        detections = proxy_fast_vision_frame(frame)
                        telemetry_service.log_frames(1, uid)
                        if any(d.get("is_weapon") for d in detections):
                            telemetry_service.log_anomaly("NODE_WS_STREAM", uid)
                            from app.notifications import notification_manager
                            weapon_det = next(d for d in detections if d.get("is_weapon"))
                            notification_manager.send_alert(
                                uid=uid,
                                title="🚨 Threat Detected in Live Detection Stream!",
                                message=f"A {weapon_det.get('class_name', 'weapon').upper()} was detected with {int(weapon_det.get('confidence', 0) * 100)}% confidence.",
                                class_name=weapon_det.get("class_name", "weapon"),
                            )

                        msg = {
                            "timestamp": timestamp,
                            "detections": detections,
                        }
                        await websocket.send_text(json.dumps(msg))
                except Exception as e:
                    print(f"Frame processing error: {e}")

    except WebSocketDisconnect:
        print(f"\n[WS DETECT] Client disconnected for video {video_id}")
    except Exception as e:
        print(f"[WS DETECT] Unexpected error for video {video_id}: {e}")


# ==================== Stream Management ====================


class StreamCreateRequest(BaseModel):
    name: str
    stream_type: str
    source: str
    uid: str
    model_id: str = "latest"
    device_id: str = ""


@app.get("/api/streams")
async def list_streams(uid: str = "anonymous"):
    """Return all active streams globally."""
    _restore_streams_from_firebase()

    all_streams = stream_manager.list_streams()
    return {"streams": all_streams}


@app.post("/api/streams")
async def create_stream(req: StreamCreateRequest):
    print(f"\n[API] POST /api/streams - Received request to create stream: {req.name}, type: {req.stream_type}")
    stream = stream_manager.add_stream(
        name=req.name,
        stream_type=req.stream_type,
        source=req.source,
        uid=req.uid,
        model_id=req.model_id,
        device_id=req.device_id,
    )
    
    # Save to Firebase
    try:
        stream_data = {
            "name": req.name,
            "type": req.stream_type,
            "source": req.source,
            "uid": req.uid,
            "model_id": req.model_id,
            "device_id": req.device_id,
            "created_at": __import__("datetime").datetime.now().isoformat()
        }
        requests.put(f"{FIREBASE_RTDB_BASE}/streams/{req.uid}/{stream.id}.json", json=stream_data)
    except Exception as e:
        print(f"[API] POST /api/streams - Failed to persist stream {stream.id} to Firebase: {e}")


    print(f"[API] POST /api/streams - Successfully created stream {stream.id}")
    return {"status": "success", "stream_id": stream.id, "stream": stream.to_dict()}


@app.delete("/api/streams/{stream_id}")
async def delete_stream(stream_id: str, uid: str = "anonymous"):
    print(f"\n[API] DELETE /api/streams/{stream_id} - Received request to delete stream")
    stream = stream_manager.get_stream(stream_id)
    stream_uid = stream.uid if stream else uid

    await stream_manager.remove_stream(stream_id)
    
    # Remove from Firebase
    try:
        requests.delete(f"{FIREBASE_RTDB_BASE}/streams/{stream_uid}/{stream_id}.json")
    except Exception as e:
        print(f"[API] DELETE /api/streams/{stream_id} - Failed to remove stream from Firebase: {e}")


    print(f"[API] DELETE /api/streams/{stream_id} - Successfully deleted stream")
    return {"status": "success"}





# ==================== Stream Input (frames from camera provider — AI only) ====================


@app.websocket("/ws/stream_in/{stream_id}")
async def websocket_stream_in(websocket: WebSocket, stream_id: str):
    """
    Receives binary JPEG frames from the camera provider.
    Decodes for AI inference and stores base64 for viewer broadcast.
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

            if "bytes" in message and message["bytes"]:
                jpeg_bytes = message["bytes"]

                # Store base64 for viewer broadcast
                stream.latest_frame_b64 = base64.b64encode(jpeg_bytes).decode("utf-8")

                # Decode for AI in background
                async def _bg_decode(data: bytes):
                    frame = await _aio.to_thread(_decode_jpeg, data)
                    if frame is not None:
                        stream.latest_frame_cv2 = frame
                _aio.create_task(_bg_decode(jpeg_bytes))

    except WebSocketDisconnect:
        logger.info(f"[WS IN] Camera provider disconnected from stream {stream_id}")
    except Exception as e:
        logger.error(f"[WS IN] Error on stream {stream_id}: {e}")
    finally:
        if stream_manager.get_stream(stream_id):
            stream.status = "waiting_for_client"


# ==================== Stream Output (frames + detections via WebSocket) ====================


@app.websocket("/ws/stream_out/{stream_id}")
async def websocket_stream_out(websocket: WebSocket, stream_id: str):
    """
    Viewers subscribe here for video frames and AI detection overlay data.
    Receives combined frame + detection JSON payloads.
    """
    await websocket.accept()
    stream = stream_manager.get_stream(stream_id)
    if not stream:
        await websocket.close(code=1008)
        return

    logger.info(f"[WS OUT] Viewer connected to stream {stream_id}")
    stream.viewer_wss.add(websocket)
    try:
        while stream._running and stream_manager.get_stream(stream_id):
            # Use generic receive() to handle text pings or disconnect
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        stream.viewer_wss.discard(websocket)
        logger.info(f"[WS OUT] Viewer disconnected from stream {stream_id}")
