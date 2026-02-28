import os
import uuid
import cv2
import logging
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.detector import WeaponDetector, WEAPON_CLASSES
import json
import base64
import numpy as np
import torch
from pydantic import BaseModel
from typing import List
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

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"

# GPU Memory management for active detectors
current_model_id = None
global_detector = None


def get_detector(model_id: str = "latest"):
    global current_model_id, global_detector

    if current_model_id != model_id or global_detector is None:
        if global_detector is not None:
            if hasattr(global_detector, "model") and global_detector.model is not None:
                del global_detector.model
            global_detector = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        print(f"Loading YOLO weapon detector (model_id={model_id})")
        global_detector = WeaponDetector(model_path=model_id)
        current_model_id = model_id

    return global_detector


@app.get("/api/models")
def list_models():
    """Returns all available trained models from runs/detect/."""
    return {"models": WeaponDetector.list_available_models()}


@app.get("/api/health")
def health_check():
    """Simple health endpoint for tunnel / load-balancer probes."""
    return {
        "status": "ok",
        "gpu": torch.cuda.is_available(),
        "model_loaded": global_detector is not None,
    }


@app.on_event("startup")
async def preload_model():
    """Pre-load the YOLO detector at startup so the first WS connection isn't delayed."""
    print("[STARTUP] Pre-loading YOLO weapon detector...")
    get_detector("latest")
    
    print("[STARTUP] Restoring streams from Firebase...")
    try:
        resp = requests.get(f"{FIREBASE_RTDB_BASE}/streams.json")
        if resp.status_code == 200 and resp.json():
            streams_by_user = resp.json()
            for user_uid, streams_dict in streams_by_user.items():
                if isinstance(streams_dict, dict):
                    for st_id, st_data in streams_dict.items():
                        stream_manager.add_stream(
                            name=st_data.get("name", "Unknown"),
                            stream_type=st_data.get("type", "rtsp"),
                            source=st_data.get("source", "0"),
                            uid=user_uid,
                            model_id=st_data.get("model_id", "latest"),
                            device_id=st_data.get("device_id", ""),
                            stream_id=st_id
                        )
    except Exception as e:
        print(f"[STARTUP] Error restoring streams from Firebase: {e}")
        
    print("[STARTUP] YOLO weapon detector ready!")

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
    Pre-analyzes the entire uploaded video server-side using YOLO batch inference.
    Streams results via Server-Sent Events (SSE).
    """
    matching = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(video_id)]
    if not matching:
        return {"error": "Video not found"}

    file_path = os.path.join(UPLOAD_DIR, matching[0])

    BATCH_SIZE = 8  # Process 8 frames at once on GPU

    def generate():
        detector = get_detector(model_id)
        cap = cv2.VideoCapture(file_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        # Sample ~10 frames per second for accuracy (every 3rd frame at 30fps)
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

                # When batch is full, run inference on all frames at once
                if len(batch_frames) >= BATCH_SIZE:
                    batch_detections = detector.process_batch(batch_frames)

                    for ts, dets in zip(batch_timestamps, batch_detections):
                        sample_count += 1
                        telemetry_service.log_frames(sample_interval, uid)
                        if any(d.get("is_weapon") for d in dets):
                            telemetry_service.log_anomaly("NODE_PREANALYSIS", uid)

                        progress = sample_count / max(total_samples, 1)
                        yield f"data: {json.dumps({'type': 'frame', 'timestamp': ts, 'detections': dets, 'progress': round(progress, 3)})}\n\n"

                    batch_frames = []
                    batch_timestamps = []

            frame_idx += 1

        # Process remaining frames in the last partial batch
        if batch_frames:
            batch_detections = detector.process_batch(batch_frames)
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

    my_detector = get_detector(model)

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
                        detections = my_detector.process_frame(frame)
                        telemetry_service.log_frames(1, uid)
                        if any(d.get("is_weapon") for d in detections):
                            telemetry_service.log_anomaly("NODE_WS_STREAM", uid)

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
def list_streams(uid: str = "anonymous"):
    all_streams = stream_manager.list_streams()
    user_streams = [s for s in all_streams if s.get("uid") == uid]
    return {"streams": user_streams}


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
    return {"status": "success", "stream_id": stream.id}


@app.delete("/api/streams/{stream_id}")
async def delete_stream(stream_id: str, uid: str = "anonymous"):
    print(f"\n[API] DELETE /api/streams/{stream_id} - Received request to delete stream")
    stream_manager.remove_stream(stream_id)
    
    # Remove from Firebase
    try:
        requests.delete(f"{FIREBASE_RTDB_BASE}/streams/{uid}/{stream_id}.json")
    except Exception as e:
        print(f"[API] DELETE /api/streams/{stream_id} - Failed to remove stream from Firebase: {e}")
        
    print(f"[API] DELETE /api/streams/{stream_id} - Successfully deleted stream")
    return {"status": "success"}


# ==================== WebRTC Signaling Endpoint ====================


@app.websocket("/ws/signal/{stream_id}")
async def websocket_signal(websocket: WebSocket, stream_id: str):
    """
    WebRTC signaling relay for a specific stream.

    The camera provider and each viewer connect here.
    Messages are JSON with a "type" field:

    From provider:
      - { type: "provider-ready" }                          — register as the camera provider
      - { type: "offer", peerId: "...", sdp: "..." }        — SDP offer targeted at a viewer
      - { type: "answer", peerId: "...", sdp: "..." }       — SDP answer (unused normally, but supported)
      - { type: "ice-candidate", peerId: "...", candidate: {...} } — ICE candidate for a specific viewer

    From viewer:
      - { type: "viewer-join", peerId: "..." }              — register as a viewer
      - { type: "answer", peerId: "...", sdp: "..." }       — SDP answer back to provider
      - { type: "ice-candidate", peerId: "...", candidate: {...} } — ICE candidate for provider
    """
    await websocket.accept()
    stream = stream_manager.get_stream(stream_id)
    if not stream:
        await websocket.close(code=1008, reason="Stream not found")
        return

    role = None  # "provider" or "viewer"
    peer_id = None

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            msg_type = msg.get("type", "")

            # ----- Provider registration
            if msg_type == "provider-ready":
                role = "provider"
                stream.provider_signal_ws = websocket
                stream.status = "active"
                logger.info(f"[SIGNAL] Provider registered for stream {stream_id}")

                # Tell provider about any viewers already connected
                for vid in list(stream.viewer_signal_wss.keys()):
                    await stream_manager.notify_provider_viewer_joined(stream, vid)

            # ----- Viewer registration
            elif msg_type == "viewer-join":
                role = "viewer"
                peer_id = msg.get("peerId", str(uuid.uuid4()))
                stream.viewer_signal_wss[peer_id] = websocket
                logger.info(f"[SIGNAL] Viewer {peer_id} joined stream {stream_id}")

                # Notify provider so it creates a peer connection + offer
                await stream_manager.notify_provider_viewer_joined(stream, peer_id)

            # ----- SDP Offer (provider → viewer)
            elif msg_type == "offer":
                target_peer = msg.get("peerId")
                if target_peer:
                    await stream_manager.relay_signal_to_viewer(stream, target_peer, {
                        "type": "offer",
                        "sdp": msg.get("sdp"),
                    })

            # ----- SDP Answer (viewer → provider)
            elif msg_type == "answer":
                target_peer = msg.get("peerId")
                await stream_manager.relay_signal_to_provider(stream, {
                    "type": "answer",
                    "peerId": target_peer or peer_id,
                    "sdp": msg.get("sdp"),
                })

            # ----- ICE Candidate (both directions)
            elif msg_type == "ice-candidate":
                candidate = msg.get("candidate")
                target_peer = msg.get("peerId")

                if role == "provider" and target_peer:
                    # Provider sending ICE to a specific viewer
                    await stream_manager.relay_signal_to_viewer(stream, target_peer, {
                        "type": "ice-candidate",
                        "candidate": candidate,
                    })
                elif role == "viewer":
                    # Viewer sending ICE to provider
                    await stream_manager.relay_signal_to_provider(stream, {
                        "type": "ice-candidate",
                        "peerId": peer_id,
                        "candidate": candidate,
                    })

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"[SIGNAL] Error in signaling WS for stream {stream_id}: {e}")
    finally:
        if role == "provider":
            if stream_manager.get_stream(stream_id):
                stream.provider_signal_ws = None
                stream.status = "waiting_for_client"
            logger.info(f"[SIGNAL] Provider disconnected from stream {stream_id}")
        elif role == "viewer" and peer_id:
            if stream_manager.get_stream(stream_id):
                stream.viewer_signal_wss.pop(peer_id, None)
                await stream_manager.notify_provider_viewer_left(stream, peer_id)
            logger.info(f"[SIGNAL] Viewer {peer_id} disconnected from stream {stream_id}")


# ==================== Stream Input (AI frames from camera provider) ====================


@app.websocket("/ws/stream_in/{stream_id}")
async def websocket_stream_in(websocket: WebSocket, stream_id: str):
    """
    Receives low-res JPEG frames from the camera provider for AI inference only.
    No longer re-broadcasts frames to viewers (WebRTC handles that).
    """
    import asyncio as _aio

    await websocket.accept()
    stream = stream_manager.get_stream(stream_id)
    if not stream or stream.type != "client_cam":
        await websocket.close(code=1008)
        return

    logger.info(f"[WS IN] Camera provider connected for AI frames on stream {stream_id}")
    stream.status = "active"

    def _decode_frame(b64_img: str):
        """Decode base64 JPEG → cv2 frame (runs in thread pool)."""
        raw = b64_img.split(',', 1)[-1] if ',' in b64_img else b64_img
        img_bytes = base64.b64decode(raw)
        np_arr = np.frombuffer(img_bytes, np.uint8)
        return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    try:
        while stream._running:
            data = await websocket.receive_text()
            payload = json.loads(data)
            if payload.get("type") == "frame":
                # Decode in thread to avoid blocking the event loop
                frame = await _aio.to_thread(_decode_frame, payload["frame"])
                if frame is not None:
                    # Store reference directly — AI loop picks it up via id() change
                    stream.latest_frame_cv2 = frame

    except WebSocketDisconnect:
        logger.info(f"[WS IN] Camera provider disconnected from stream {stream_id}")
    except Exception as e:
        logger.error(f"[WS IN] Error on stream {stream_id}: {e}")
    finally:
        if stream_manager.get_stream(stream_id):
            stream.status = "waiting_for_client"


# ==================== Stream Output (detection results + fallback frames) ====================


@app.websocket("/ws/stream_out/{stream_id}")
async def websocket_stream_out(websocket: WebSocket, stream_id: str):
    """
    Viewers subscribe here to receive:
    - For client_cam streams: detection-only JSON (video comes via WebRTC)
    - For server_cam/rtsp streams: full frame + detection JSON (fallback mode)
    """
    await websocket.accept()
    stream = stream_manager.get_stream(stream_id)
    if not stream:
        await websocket.close(code=1008)
        return

    if stream.type == "client_cam":
        # WebRTC handles video; this WS is detection-results only
        logger.info(f"[WS OUT] Detection subscriber connected to client_cam stream {stream_id}")
        stream.detection_wss.add(websocket)
        try:
            while stream._running:
                # Keep connection alive; server pushes detection data
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            stream.detection_wss.discard(websocket)
            logger.info(f"[WS OUT] Detection subscriber disconnected from stream {stream_id}")
    else:
        # server_cam / rtsp — full frame broadcast (fallback, no WebRTC for server streams)
        logger.info(f"[WS OUT] Fallback frame subscriber connected to stream {stream_id}")
        stream.fallback_wss.add(websocket)
        try:
            while stream._running:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            stream.fallback_wss.discard(websocket)
            logger.info(f"[WS OUT] Fallback subscriber disconnected from stream {stream_id}")
