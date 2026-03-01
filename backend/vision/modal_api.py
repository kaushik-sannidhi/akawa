"""
Akawa Vision Threat Detection API — Modal Deployment

Endpoint:
  1. Qwen2VLModel  — VLM-based deep visual analysis (1x A100)
  2. FastVisionAPI — YOLO weapon + Two-Stream violence + pose fall detection (1x A100)

Deploy:  modal deploy akawa/backend/vision/modal_api.py
Download weights once:  modal run akawa/backend/vision/modal_api.py::download_model
"""

import modal
from pydantic import BaseModel
from typing import Dict, List, Optional
import math

# ═══════════════════════════════════════════════════════════════════════════════
# Modal App
# ═══════════════════════════════════════════════════════════════════════════════
app = modal.App("akawa-vlm-api")

# ═══════════════════════════════════════════════════════════════════════════════
# Fall Detection Helpers
# ═══════════════════════════════════════════════════════════════════════════════
NOSE, L_EYE, R_EYE, L_EAR, R_EAR = 0, 1, 2, 3, 4
L_SHOULDER, R_SHOULDER = 5, 6
L_ELBOW, R_ELBOW = 7, 8
L_WRIST, R_WRIST = 9, 10
L_HIP, R_HIP = 11, 12
L_KNEE, R_KNEE = 13, 14
L_ANKLE, R_ANKLE = 15, 16

def kp_xy(kps, idx):
    if kps is None or len(kps) <= idx: return None
    x, y, c = float(kps[idx][0]), float(kps[idx][1]), float(kps[idx][2])
    return (x, y) if c > 0.3 else None

def angle_deg(p1, p2):
    if p1 is None or p2 is None: return None
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    return math.degrees(math.atan2(abs(dy), abs(dx) + 1e-6))

def bbox_iou(b1, b2):
    ix1, iy1 = max(b1[0], b2[0]), max(b1[1], b2[1])
    ix2, iy2 = min(b1[2], b2[2]), min(b1[3], b2[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0: return 0.0
    a1 = (b1[2] - b1[0]) * (b1[3] - b1[1])
    a2 = (b2[2] - b2[0]) * (b2[3] - b2[1])
    return inter / (a1 + a2 - inter + 1e-6)

class EventTracker:
    def __init__(self, max_age=10):
        self.max_age = max_age
        self.events = []

    def update(self, current_events):
        for e in self.events: e['age'] += 1
        for curr in current_events:
            matched = False
            for e in self.events:
                if (e['label'].split(' ')[1] == curr['label'].split(' ')[1]
                        and bbox_iou(curr['box'], e['box']) > 0.3):
                    e['box'] = curr['box']
                    e['label'] = curr['label']
                    e['age'] = 0
                    matched = True
                    break
            if not matched:
                curr['age'] = 0
                self.events.append(curr)
        self.events = [e for e in self.events if e['age'] < self.max_age]

    def get_active(self):
        return self.events


# ═══════════════════════════════════════════════════════════════════════════════
# ENDPOINT — Qwen2-VL Deep Analysis (1x A100 GPU)
# ═══════════════════════════════════════════════════════════════════════════════

qwen2_vl_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.4.0",
        "transformers>=4.45.0",
        "accelerate>=0.34.2",
        "qwen-vl-utils>=0.0.8",
        "torchvision==0.19.0",
        "fastapi[standard]",
        "pydantic",
        "pillow",
    )
)

qwen2_vl_volume = modal.Volume.from_name("qwen2-vl-7b-weights", create_if_missing=True)
QWEN2_VL_MODEL_DIR = "/model_cache"
QWEN2_VL_MODEL_ID  = "Qwen/Qwen2-VL-7B-Instruct"

@app.function(image=qwen2_vl_image, volumes={QWEN2_VL_MODEL_DIR: qwen2_vl_volume}, timeout=7200)
def download_model():
    from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
    import torch
    print(f"Downloading {QWEN2_VL_MODEL_ID} ...")
    AutoProcessor.from_pretrained(QWEN2_VL_MODEL_ID, cache_dir=QWEN2_VL_MODEL_DIR)
    Qwen2VLForConditionalGeneration.from_pretrained(
        QWEN2_VL_MODEL_ID, device_map="auto",
        torch_dtype=torch.bfloat16, cache_dir=QWEN2_VL_MODEL_DIR
    )
    print("Done.")
    qwen2_vl_volume.commit()


class Qwen2VLRequest(BaseModel):
    video_b64: str
    video_name: Optional[str] = "unknown_video"
    prompt: Optional[str] = (
        "You are a specialized security analyst. Your goal is to provide a detailed, "
        "objective description of every person in the video and their exact physical actions. "
        "For each person, describe their clothing, appearance, and what they are doing to others "
        "or the environment. Focus on physical interactions: grappling, punching, grabbing, "
        "struggling, dragging, or protective stances. Describe exactly who is doing what to whom "
        "in high detail."
    )

class Qwen2VLResponse(BaseModel):
    text: str
    error: Optional[str] = None


@app.cls(
    image=qwen2_vl_image,
    gpu="A100",
    volumes={QWEN2_VL_MODEL_DIR: qwen2_vl_volume},
    min_containers=1,
    timeout=300,
)
class Qwen2VLModel:
    @modal.enter()
    def load_model(self):
        import torch
        from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
        print("Loading Qwen2-VL-7B ...")
        self.processor = AutoProcessor.from_pretrained(QWEN2_VL_MODEL_ID, cache_dir=QWEN2_VL_MODEL_DIR)
        self.model = Qwen2VLForConditionalGeneration.from_pretrained(
            QWEN2_VL_MODEL_ID, device_map="auto",
            torch_dtype=torch.bfloat16, cache_dir=QWEN2_VL_MODEL_DIR,
        )
        self.model.eval()
        print("Qwen2-VL loaded.")

    @modal.fastapi_endpoint(method="POST", docs=True)
    def analyze(self, req: Qwen2VLRequest) -> Qwen2VLResponse:
        import base64, torch, traceback, tempfile, os, logging
        from qwen_vl_utils import process_vision_info

        logger = logging.getLogger("qwen2_vl")
        logging.basicConfig(level=logging.INFO)
        video_name = req.video_name or "unknown_video"
        temp_video_path = None
        try:
            video_bytes = base64.b64decode(req.video_b64)
            fd, temp_video_path = tempfile.mkstemp(suffix=".webm")
            with os.fdopen(fd, 'wb') as f:
                f.write(video_bytes)

            messages = [{
                "role": "user",
                "content": [
                    {"type": "video", "video": temp_video_path,
                     "max_pixels": 250880, "fps": 5.0},
                    {"type": "text", "text": req.prompt},
                ],
            }]
            text = self.processor.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            image_inputs, video_inputs = process_vision_info(messages)
            inputs = self.processor(
                text=[text], images=image_inputs, videos=video_inputs,
                padding=True, return_tensors="pt",
            ).to(self.model.device)

            with torch.no_grad():
                generated_ids = self.model.generate(**inputs, max_new_tokens=500)
            trimmed = [out[len(inp):] for inp, out in zip(inputs.input_ids, generated_ids)]
            output_text = self.processor.batch_decode(
                trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
            )[0]
            return Qwen2VLResponse(text=output_text.strip())

        except Exception as e:
            traceback.print_exc()
            return Qwen2VLResponse(text="", error=str(e))
        finally:
            if temp_video_path and os.path.exists(temp_video_path):
                try: os.remove(temp_video_path)
                except: pass


# ═══════════════════════════════════════════════════════════════════════════════
# ENDPOINT — Fast Vision (Weapon + Violence + Fall Detection)
# ═══════════════════════════════════════════════════════════════════════════════

fast_vision_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "tensorflow[and-cuda]",
        "ultralytics",
        "opencv-python-headless",
        "fastapi[standard]",
        "pydantic",
        "pillow",
        "numpy",
        "torch>=2.0.0",
    )
    .add_local_dir("backend/vision/models", remote_path="/root/models")
)

# ── Weapon classes ──────────────────────────────────────────────────────────
WEAPON_CLASSES = {"gun", "knife", "weapon"}

# ── How many sampled frames must contain a weapon to suppress brawl model ──
# e.g. 0.25 means weapon found in ≥25% of sampled frames → skip brawl
WEAPON_DOMINANCE_RATIO = 0.25

# ── Thresholds ──────────────────────────────────────────────────────────────
WEAPON_CONF_THRESH   = 0.45   # YOLO box confidence for a weapon hit
WEAPON_ALERT_THRESH  = 0.50   # max_weapon_conf to declare weapons_detected
BRAWL_ALERT_THRESH   = 0.60   # brawl model probability to declare violence
FALL_CONFIRM_THRESH  = 0.50   # fall judge confidence
PERSON_DETECT_CONF   = 0.40   # pose model person confidence


# ── Schemas ──────────────────────────────────────────────────────────────────
class FastVisionRequest(BaseModel):
    # Live sequence path (primary use-case)
    frame_sequence_b64: Optional[List[str]] = None

    # Single-frame WebSocket path
    frame_b64: Optional[str] = None

    # Full video upload path
    video_b64: Optional[str] = None

    video_name: Optional[str] = "live_stream"
    source_type: Optional[str] = "live"   # "live" | "upload"

    # Per-stream identifier — critical for multi-camera deployments.
    # The backend uses this to persist the last frame's grayscale between
    # batches so optical flow is continuous across batch boundaries.
    stream_id: Optional[str] = "default"


class Detection(BaseModel):
    bbox: List[float]           # normalised [x1, y1, x2, y2]
    confidence: float
    class_name: str
    detection_type: str         # "person" | "weapon" | "fall" | "violent_person"


class FastVisionResponse(BaseModel):
    # Top-level flags
    weapons_detected: bool
    weapon_confidence: float
    violence_detected: bool
    violence_confidence: float
    fall_detected: bool = False
    fall_confidence: float = 0.0

    # Single summary field the UI can use for alert colour / icon
    # Priority: weapon > fall > violence > none
    threat_type: str = "none"   # "none" | "weapon" | "violence" | "fall"

    # Per-frame bounding boxes (always populated — persons even when no threat)
    detections: Optional[List[Detection]] = None

    # New: Grouped detections per frame index (0 to SEQUENCE_LENGTH-1)
    per_frame_detections: Optional[Dict[int, List[Detection]]] = None

    # Raw brawl model output (useful for debugging thresholds)
    raw_brawl_confidence: Optional[float] = None

    error: Optional[str] = None


# ── Optical-flow helper ──────────────────────────────────────────────────────
def _compute_optical_flow(prev_gray, curr_gray):
    import cv2
    flow = cv2.calcOpticalFlowFarneback(
        prev_gray, curr_gray, None,
        pyr_scale=0.5, levels=3, winsize=15,
        iterations=5, poly_n=5, poly_sigma=1.1, flags=0,
    )
    return flow


@app.cls(
    image=fast_vision_image,
    gpu="A100",
    min_containers=1,
    timeout=300,
)
class FastVisionAPI:
    """
    Threat detection pipeline:
      1. YOLO weapon scan — runs on every other frame in the sequence.
         If weapon found in ≥WEAPON_DOMINANCE_RATIO of scanned frames
         → skip brawl model entirely (motion from weapon-wielding looks
           identical to a brawl to a CNN).
      2. Two-Stream brawl model — only runs when no weapon dominance.
      3. YOLO-pose fall detection — always runs on the last frame.
      4. Person bboxes — always returned from pose so the UI shows
         the model is working even during quiet footage.

    Per-stream state (keyed by stream_id):
      - prev_gray: last grayscale frame from the previous batch, so
        optical flow is continuous across batch boundaries.
      - event_tracker: per-stream fall tracker.
    """

    @modal.enter()
    def load_models(self):
        import tensorflow as tf
        import torch
        from ultralytics import YOLO
        import ultralytics.nn.tasks
        import os

        print("Loading Fast Vision models ...")

        try:
            torch.serialization.add_safe_globals([ultralytics.nn.tasks.DetectionModel])
        except AttributeError:
            pass

        self.weapon_model = YOLO('/root/models/weapon.pt')
        self.brawl_model  = tf.keras.models.load_model('/root/models/brawl_model.keras')
        self.pose_model   = YOLO('/root/models/yolo11m-pose.pt')

        self.fall_judge = None
        if os.path.exists('/root/models/fall_best.pt'):
            self.fall_judge = YOLO('/root/models/fall_best.pt')

        # Per-stream state: stream_id → {"prev_gray": ndarray|None, "tracker": EventTracker}
        self._stream_state: dict = {}

        self.FALL_SPINE_ANGLE_DEG  = 45
        self.FALL_HEAD_ANKLE_FRAC  = 0.15
        print("Fast Vision models loaded.")

    # ── Per-stream state helpers ─────────────────────────────────────────────
    def _get_stream_state(self, stream_id: str) -> dict:
        if stream_id not in self._stream_state:
            self._stream_state[stream_id] = {
                "prev_gray": None,
                "tracker": EventTracker(max_age=10),
            }
        return self._stream_state[stream_id]

    # ── Fall detection helpers ───────────────────────────────────────────────
    def _check_suspicion(self, kps, bbox):
        ls, rs = kp_xy(kps, L_SHOULDER), kp_xy(kps, R_SHOULDER)
        lh, rh = kp_xy(kps, L_HIP),      kp_xy(kps, R_HIP)
        neck  = ((ls[0]+rs[0])/2, (ls[1]+rs[1])/2) if (ls and rs) else None
        mhip  = ((lh[0]+rh[0])/2, (lh[1]+rh[1])/2) if (lh and rh) else None

        sp_angle = angle_deg(neck, mhip)
        if sp_angle is not None and sp_angle < self.FALL_SPINE_ANGLE_DEG:
            return True, f"Spine {sp_angle:.0f}°"

        head, la, ra = kp_xy(kps, NOSE), kp_xy(kps, L_ANKLE), kp_xy(kps, R_ANKLE)
        ankle = la or ra
        if head and ankle:
            bbox_h = bbox[3] - bbox[1] + 1e-6
            if abs(head[1] - ankle[1]) / bbox_h < self.FALL_HEAD_ANKLE_FRAC:
                return True, "Head≈Ankle"
        return False, ""

    def _run_judge(self, frame, bbox):
        import cv2
        x1, y1, x2, y2 = bbox
        h, w = frame.shape[:2]
        pad = 20
        x1, y1 = max(0, int(x1-pad)), max(0, int(y1-pad))
        x2, y2 = min(w, int(x2+pad)), min(h, int(y2+pad))
        crop = frame[y1:y2, x1:x2]
        if crop is None or crop.size == 0: return False, 0.0
        results = self.fall_judge.predict(source=crop, conf=FALL_CONFIRM_THRESH, verbose=False)
        if results[0].boxes is not None and len(results[0].boxes) > 0:
            best_conf = float(results[0].boxes.conf.max())
            return best_conf >= FALL_CONFIRM_THRESH, best_conf
        return False, 0.0

    # ── Shared weapon scanning ───────────────────────────────────────────────
    def _scan_weapons(self, frames, frame_height: int, frame_width: int):
        """
        Run weapon YOLO on every other frame.
        Returns (max_weapon_conf, weapon_hit_ratio, weapon_detections[], per_frame_weapon_dets).
        weapon_detections contains normalised Detection objects for the frames
        where a weapon was found.
        per_frame_weapon_dets is a dict {frame_idx: [Detection]}
        """
        import numpy as np

        class_names = (self.weapon_model.names
                       if hasattr(self.weapon_model, "names")
                       else getattr(self.weapon_model.model, "names",
                                    {0: "person", 1: "gun", 2: "knife"}))

        weapon_confidences = []
        weapon_detections  = []
        per_frame_weapon_dets = {}
        scanned = 0

        for i, frame in enumerate(frames):
            if i % 2 != 0:
                continue
            scanned += 1
            h, w = frame.shape[:2]
            results = self.weapon_model(frame, verbose=False)
            frame_dets = []
            for r in results:
                for j in range(len(r.boxes)):
                    cls_id    = int(r.boxes.cls[j].item())
                    conf      = float(r.boxes.conf[j].item())
                    class_name = (class_names[cls_id]
                                  if isinstance(class_names, dict)
                                  else (class_names[cls_id]
                                        if cls_id < len(class_names)
                                        else f"class_{cls_id}"))
                    is_weapon = class_name in WEAPON_CLASSES
                    if not is_weapon or conf < WEAPON_CONF_THRESH:
                        continue

                    weapon_confidences.append(conf)

                    # Normalise bbox
                    if hasattr(r.boxes, "xyxyn"):
                        xyxyn = r.boxes.xyxyn[j].tolist()
                    else:
                        raw = r.boxes.xyxy[j].tolist()
                        xyxyn = [raw[0]/w, raw[1]/h, raw[2]/w, raw[3]/h]

                    det = Detection(
                        bbox=xyxyn,
                        confidence=conf,
                        class_name=class_name,
                        detection_type="weapon",
                    )
                    weapon_detections.append(det)
                    frame_dets.append(det)
            
            if frame_dets:
                per_frame_weapon_dets[i] = frame_dets

        max_conf  = max(weapon_confidences) if weapon_confidences else 0.0
        hit_ratio = len(weapon_confidences) / max(scanned, 1)
        return max_conf, hit_ratio, weapon_detections, per_frame_weapon_dets

    # ── Shared pose / fall / person bbox extraction ──────────────────────────
    def _run_pose(self, frame, tracker: EventTracker):
        """
        Returns (fall_detected, max_fall_conf, person_detections[], fall_detections[]).
        person_detections always contains every detected person.
        """
        h, w = frame.shape[:2]
        person_detections = []
        fall_detections   = []
        fall_detected     = False
        max_fall_conf     = 0.0

        pose_results = self.pose_model(frame, verbose=False, imgsz=640, conf=PERSON_DETECT_CONF)
        res = pose_results[0]

        if res.boxes is None or len(res.boxes) == 0:
            tracker.update([])
            return fall_detected, max_fall_conf, person_detections, fall_detections

        boxes_xyxy = [[int(v) for v in b.tolist()] for b in res.boxes.xyxy]
        keypoints_list = []
        if res.keypoints is not None and res.keypoints.data is not None:
            for kp_tensor in res.keypoints.data:
                keypoints_list.append(kp_tensor.cpu().numpy())
        else:
            keypoints_list = [None] * len(boxes_xyxy)

        current_events = []
        for idx, (bbox, kps) in enumerate(zip(boxes_xyxy, keypoints_list)):
            # Always add person bbox
            xyxyn = [bbox[0]/w, bbox[1]/h, bbox[2]/w, bbox[3]/h]
            person_detections.append(Detection(
                bbox=xyxyn,
                confidence=float(res.boxes.conf[idx].item()),
                class_name="person",
                detection_type="person",
            ))

            # Fall check
            suspicious, reason = self._check_suspicion(kps, bbox)
            if suspicious:
                confirmed, conf_val = False, 0.85
                if self.fall_judge:
                    confirmed, conf_val = self._run_judge(frame, bbox)
                else:
                    confirmed = True
                if confirmed:
                    label = f"🚨 CONFIRMED FALL {conf_val:.2f}"
                    current_events.append({'box': bbox, 'label': label})

        tracker.update(current_events)

        for ev in tracker.get_active():
            b = ev['box']
            xyxyn = [b[0]/w, b[1]/h, b[2]/w, b[3]/h]
            conf = 0.85
            try: conf = float(ev['label'].split(' ')[-1])
            except: pass
            fall_detections.append(Detection(
                bbox=xyxyn,
                confidence=conf,
                class_name="fall",
                detection_type="fall",
            ))
            fall_detected = True
            max_fall_conf = max(max_fall_conf, conf)

        return fall_detected, max_fall_conf, person_detections, fall_detections

    # ── Main endpoint ────────────────────────────────────────────────────────
    @modal.fastapi_endpoint(method="POST", docs=True)
    def analyze(self, req: FastVisionRequest) -> FastVisionResponse:
        import base64, cv2, numpy as np, traceback, tempfile, os, logging

        logging.basicConfig(level=logging.INFO)
        logger     = logging.getLogger("fast_vision")
        video_name = req.video_name  or "live_stream"
        stream_id  = req.stream_id   or "default"
        state      = self._get_stream_state(stream_id)

        logger.info(f"[FastVision] stream={stream_id} src={req.source_type} video={video_name}")

        # ════════════════════════════════════════════════════════════════════
        # PATH A — Frame sequence (primary live path, 20 frames from frontend)
        # ════════════════════════════════════════════════════════════════════
        if req.frame_sequence_b64:
            try:
                # 1. Decode frames
                frames = []
                for encoded in req.frame_sequence_b64:
                    if "," in encoded:
                        encoded = encoded.split(",", 1)[1]
                    img_data = base64.b64decode(encoded)
                    nparr    = np.frombuffer(img_data, np.uint8)
                    f        = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    if f is not None:
                        frames.append(f)

                if not frames:
                    return FastVisionResponse(
                        weapons_detected=False, weapon_confidence=0.0,
                        violence_detected=False, violence_confidence=0.0,
                        error="No decodable frames received",
                    )

                IMG_SIZE = (84, 84)
                SEQ_LEN  = 20

                # ── 2. Weapon scan across the whole sequence ─────────────
                # We scan every other frame (10 samples from a 20-frame batch).
                # If weapon found in ≥WEAPON_DOMINANCE_RATIO of those samples
                # we skip the brawl model entirely — fast motion from wielding
                # a weapon is indistinguishable from a brawl to the CNN.
                max_weapon_conf, weapon_hit_ratio, weapon_detections, per_frame_weapon_dets = \
                    self._scan_weapons(frames, *frames[0].shape[:2])

                weapons_detected = max_weapon_conf >= WEAPON_ALERT_THRESH
                weapon_dominant  = weapon_hit_ratio >= WEAPON_DOMINANCE_RATIO

                # ── 3. Pose / fall / person bboxes ───────────────────────
                # Run on multiple frames for better display
                per_frame_pose_dets = {}
                fall_detected = False
                max_fall_conf = 0.0
                all_person_dets = []
                all_fall_dets = []

                # Run pose on every 5th frame + the last frame
                pose_indices = list(range(0, len(frames), 5))
                if (len(frames) - 1) not in pose_indices:
                    pose_indices.append(len(frames) - 1)

                for idx in pose_indices:
                    f_det, f_conf, p_dets, fall_dets = self._run_pose(frames[idx], state["tracker"])
                    if f_det:
                        fall_detected = True
                        max_fall_conf = max(max_fall_conf, f_conf)
                    
                    all_person_dets.extend(p_dets)
                    all_fall_dets.extend(fall_dets)
                    per_frame_pose_dets[idx] = p_dets + fall_dets

                # ── 4. Brawl model — only when weapon is NOT dominant ────
                #
                # Why gate it?  The Two-Stream model sees optical flow
                # magnitudes.  A person walking briskly while carrying a
                # weapon produces large, directed flow that scores high for
                # "brawl".  Once we know a weapon is consistently present,
                # the motion signal is irrelevant — the weapon IS the threat.
                violence_detected   = False
                violence_confidence = 0.0
                raw_brawl_conf      = None

                if not weapon_dominant:
                    frame_buffer = []
                    # Seed optical flow with the last frame saved from the
                    # previous batch (if any), so flow is continuous.
                    prev_gray = state["prev_gray"]

                    for frame in frames[:SEQ_LEN]:
                        resized = cv2.resize(frame, IMG_SIZE)
                        rgb     = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB
                                               ).astype(np.float32) / 255.0
                        gray    = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)

                        if prev_gray is None:
                            flow = np.zeros((*IMG_SIZE, 2), dtype=np.float32)
                        else:
                            flow = _compute_optical_flow(prev_gray, gray)
                            flow = np.clip(flow / 20.0, -1.0, 1.0)
                        prev_gray = gray

                        stacked = np.concatenate([rgb, flow], axis=-1)
                        frame_buffer.append(stacked)

                    # Pad if fewer than SEQ_LEN frames arrived
                    while len(frame_buffer) < SEQ_LEN:
                        frame_buffer.append(frame_buffer[-1]
                                            if frame_buffer
                                            else np.zeros((*IMG_SIZE, 5), dtype=np.float32))

                    sequence = np.expand_dims(
                        np.array(frame_buffer[-SEQ_LEN:], dtype=np.float32), axis=0
                    )  # (1, 20, 84, 84, 5)
                    raw_brawl_conf      = float(self.brawl_model.predict(sequence, verbose=0)[0][0])
                    violence_detected   = raw_brawl_conf > BRAWL_ALERT_THRESH
                    violence_confidence = raw_brawl_conf

                # Save last frame grayscale for next batch continuity
                last_resized       = cv2.resize(frames[-1], IMG_SIZE)
                state["prev_gray"] = cv2.cvtColor(last_resized, cv2.COLOR_BGR2GRAY)

                # ── 5. Merge per-frame detections ─────────────────────────
                per_frame_detections = {}
                all_indices = set(per_frame_weapon_dets.keys()) | set(per_frame_pose_dets.keys())
                for idx in all_indices:
                    per_frame_detections[idx] = per_frame_weapon_dets.get(idx, []) + per_frame_pose_dets.get(idx, [])

                # ── 6. Threat priority ────────────────────────────────────
                weapons_detected = (max_weapon_conf >= WEAPON_ALERT_THRESH) and weapon_dominant

                # Always upgrade person markers if violence is active
                if violence_detected:
                    for d in all_person_dets:
                        d.detection_type = "violent_person"
                    for frame_dets in per_frame_detections.values():
                        for d in frame_dets:
                            if d.detection_type == "person":
                                d.detection_type = "violent_person"

                # weapon > fall > violence > none
                if weapons_detected:
                    threat_type = "weapon"
                elif fall_detected:
                    threat_type = "fall"
                elif violence_detected:
                    threat_type = "violence"
                else:
                    threat_type = "none"

                all_detections = all_person_dets + weapon_detections + all_fall_dets

                return FastVisionResponse(
                    weapons_detected=weapons_detected,
                    weapon_confidence=max_weapon_conf,
                    violence_detected=violence_detected,
                    violence_confidence=violence_confidence,
                    fall_detected=fall_detected,
                    fall_confidence=max_fall_conf,
                    threat_type=threat_type,
                    detections=all_detections,
                    per_frame_detections=per_frame_detections,
                    raw_brawl_confidence=raw_brawl_conf,
                )

            except Exception as e:
                traceback.print_exc()
                return FastVisionResponse(
                    weapons_detected=False, weapon_confidence=0.0,
                    violence_detected=False, violence_confidence=0.0,
                    error=str(e),
                )

        # ════════════════════════════════════════════════════════════════════
        # PATH B — Single frame
        # ════════════════════════════════════════════════════════════════════
        elif req.frame_b64:
            try:
                encoded = req.frame_b64
                if "," in encoded:
                    encoded = encoded.split(",", 1)[1]
                img_data = base64.b64decode(encoded)
                nparr    = np.frombuffer(img_data, np.uint8)
                frame    = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                if frame is None:
                    return FastVisionResponse(
                        weapons_detected=False, weapon_confidence=0.0,
                        violence_detected=False, violence_confidence=0.0,
                        error="Invalid image data",
                    )

                logger.info(f"[PATH B] Processing single frame for stream {stream_id}")

                max_weapon_conf, _, weapon_detections, _ = \
                    self._scan_weapons([frame], *frame.shape[:2])
                weapons_detected = max_weapon_conf >= WEAPON_ALERT_THRESH

                logger.info(f"   -> Weapon Check: max_conf={max_weapon_conf:.3f} (threshold={WEAPON_ALERT_THRESH}) detected={weapons_detected}")

                fall_detected, max_fall_conf, person_detections, fall_detections = \
                    self._run_pose(frame, state["tracker"])
                
                logger.info(f"   -> Fall Check: max_conf={max_fall_conf:.3f} detected={fall_detected}")
                for i, d in enumerate(person_detections):
                    logger.info(f"   -> Person {i}: conf={d.confidence:.3f} bbox={d.bbox}")

                # ── Roll Frames for Brawl Model in Single-Frame Mode ──
                IMG_SIZE, SEQ_LEN = (84, 84), 20
                if "brawl_buffer" not in state:
                    state["brawl_buffer"] = []
                
                resized = cv2.resize(frame, IMG_SIZE)
                rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
                gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
                prev_gray = state.get("prev_gray")
                
                if prev_gray is None:
                    flow = np.zeros((*IMG_SIZE, 2), dtype=np.float32)
                else:
                    flow = _compute_optical_flow(prev_gray, gray)
                    flow = np.clip(flow / 20.0, -1.0, 1.0)
                state["prev_gray"] = gray
                
                stacked = np.concatenate([rgb, flow], axis=-1)
                state["brawl_buffer"].append(stacked)
                
                # Keep buffer capped at SEQ_LEN
                if len(state["brawl_buffer"]) > SEQ_LEN:
                    state["brawl_buffer"] = state["brawl_buffer"][-SEQ_LEN:]
                
                violence_detected = False
                violence_confidence = 0.0
                # Only run brawl model if we have enough frames
                if len(state["brawl_buffer"]) >= 5: # Run even on partial buffers by padding
                    pad_len = SEQ_LEN - len(state["brawl_buffer"])
                    padded_buffer = [np.zeros((*IMG_SIZE, 5), dtype=np.float32)] * pad_len + state["brawl_buffer"]
                    sequence = np.expand_dims(np.array(padded_buffer, dtype=np.float32), axis=0)
                    raw_brawl_conf = float(self.brawl_model.predict(sequence, verbose=0)[0][0])
                    violence_detected = raw_brawl_conf > BRAWL_ALERT_THRESH
                    violence_confidence = raw_brawl_conf
                    logger.info(f"   -> Violence Check (Buffered): raw_conf={raw_brawl_conf:.3f} (thresh={BRAWL_ALERT_THRESH}) detected={violence_detected}")

                if weapons_detected:
                    threat_type = "weapon"
                elif fall_detected:
                    threat_type = "fall"
                elif violence_detected:
                    threat_type = "violence"
                    # Upgrade persons to violent
                    for d in person_detections:
                        d.detection_type = "violent_person"
                else:
                    threat_type = "none"

                all_detections = person_detections + weapon_detections + fall_detections

                logger.info(f"   => FINAL THREAT TYPE: {threat_type.upper()} with {len(all_detections)} detections")

                return FastVisionResponse(
                    weapons_detected=weapons_detected,
                    weapon_confidence=max_weapon_conf,
                    violence_detected=violence_detected,
                    violence_confidence=violence_confidence,
                    fall_detected=fall_detected,
                    fall_confidence=max_fall_conf,
                    threat_type=threat_type,
                    detections=all_detections,
                    per_frame_detections={0: all_detections},
                )

            except Exception as e:
                import traceback
                traceback.print_exc()
                logger.error(f"[PATH B ERROR] {str(e)}")
                return FastVisionResponse(
                    weapons_detected=False, weapon_confidence=0.0,
                    violence_detected=False, violence_confidence=0.0,
                    error=str(e),
                )

        # ════════════════════════════════════════════════════════════════════
        # PATH C — Full video upload
        # ════════════════════════════════════════════════════════════════════
        elif req.video_b64:
            temp_video_path = None
            try:
                video_bytes = base64.b64decode(req.video_b64)
                fd, temp_video_path = tempfile.mkstemp(suffix=".mp4")
                with os.fdopen(fd, 'wb') as f:
                    f.write(video_bytes)

                cap = cv2.VideoCapture(temp_video_path)
                IMG_SIZE, SEQ_LEN = (84, 84), 20

                frame_buffer       = []
                prev_gray          = None
                brawl_confidences  = []
                weapon_confidences = []
                fall_confidences   = []
                all_weapon_dets    = []
                all_person_dets    = []
                all_fall_dets      = []
                frame_count        = 0

                upload_tracker = EventTracker(max_age=10)
                while True:
                    ret, frame = cap.read()
                    if not ret: break
                    frame_count += 1

                    # Weapon + pose every 5th frame
                    if frame_count % 5 == 0:
                        _, _, w_dets, _ = self._scan_weapons([frame], *frame.shape[:2])
                        for d in w_dets:
                            weapon_confidences.append(d.confidence)
                            all_weapon_dets.append(d)

                        fd2, fc2, p_dets, fall_dets = self._run_pose(frame, upload_tracker)
                        all_person_dets.extend(p_dets)
                        all_fall_dets.extend(fall_dets)
                        if fd2: fall_confidences.extend([d.confidence for d in fall_dets])

                    # Two-Stream sliding window
                    resized = cv2.resize(frame, IMG_SIZE)
                    rgb     = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
                    gray    = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)

                    flow = (np.zeros((*IMG_SIZE, 2), dtype=np.float32) if prev_gray is None
                            else np.clip(_compute_optical_flow(prev_gray, gray) / 20.0, -1.0, 1.0))
                    prev_gray = gray

                    frame_buffer.append(np.concatenate([rgb, flow], axis=-1))
                    if len(frame_buffer) > SEQ_LEN:
                        frame_buffer.pop(0)

                    if len(frame_buffer) == SEQ_LEN:
                        sequence = np.expand_dims(
                            np.array(frame_buffer, dtype=np.float32), axis=0
                        )
                        prob = float(self.brawl_model.predict(sequence, verbose=0)[0][0])
                        brawl_confidences.append(prob)

                cap.release()

                max_weapon_conf = max(weapon_confidences) if weapon_confidences else 0.0
                max_fall_conf   = max(fall_confidences)   if fall_confidences   else 0.0
                max_brawl_conf  = max(brawl_confidences)  if brawl_confidences  else 0.0

                # Same weapon-dominance gate for full video
                weapon_hit_ratio = len(weapon_confidences) / max((frame_count // 5), 1)
                weapon_dominant  = weapon_hit_ratio >= WEAPON_DOMINANCE_RATIO

                weapons_detected  = (max_weapon_conf >= WEAPON_ALERT_THRESH) and weapon_dominant
                fall_detected     = max_fall_conf   >  FALL_CONFIRM_THRESH
                violence_detected = (not weapon_dominant) and (max_brawl_conf > BRAWL_ALERT_THRESH)

                if violence_detected:
                    # Upgrade person markers to violent_person for UI colouring
                    for d in all_person_dets:
                        d.detection_type = "violent_person"

                if weapons_detected:
                    threat_type = "weapon"
                elif fall_detected:
                    threat_type = "fall"
                elif violence_detected:
                    threat_type = "violence"
                else:
                    threat_type = "none"

                all_detections = all_person_dets + all_weapon_dets + all_fall_dets

                logger.info(
                    f"[FastVision] Upload {video_name}: threat={threat_type} "
                    f"weapon={max_weapon_conf:.2f} brawl={max_brawl_conf:.2f} "
                    f"fall={max_fall_conf:.2f}"
                )

                return FastVisionResponse(
                    weapons_detected=weapons_detected,
                    weapon_confidence=max_weapon_conf,
                    violence_detected=violence_detected,
                    violence_confidence=max_brawl_conf if not weapon_dominant else 0.0,
                    fall_detected=fall_detected,
                    fall_confidence=max_fall_conf,
                    threat_type=threat_type,
                    detections=all_detections,
                    raw_brawl_confidence=max_brawl_conf,
                )

            except Exception as e:
                traceback.print_exc()
                return FastVisionResponse(
                    weapons_detected=False, weapon_confidence=0.0,
                    violence_detected=False, violence_confidence=0.0,
                    error=str(e),
                )
            finally:
                if temp_video_path and os.path.exists(temp_video_path):
                    try: os.remove(temp_video_path)
                    except: pass

        # ── No valid input ────────────────────────────────────────────────
        return FastVisionResponse(
            weapons_detected=False, weapon_confidence=0.0,
            violence_detected=False, violence_confidence=0.0,
            error="No input provided (frame_b64, frame_sequence_b64, or video_b64 required)",
        )

    @modal.fastapi_endpoint(method="POST", docs=True)
    def detect(self, req: FastVisionRequest) -> FastVisionResponse:
        """
        Lightweight single-frame detection endpoint.
        Uses a rolling buffer to ensure the brawl model can still detect violence on a single-frame per request feed.
        """
        import base64, cv2, numpy as np, traceback, logging
        logger = logging.getLogger("fast_vision_detect")
        try:
            encoded = req.frame_b64
            if not encoded and req.frame_sequence_b64:
                encoded = req.frame_sequence_b64[-1]
            
            if not encoded:
                return FastVisionResponse(weapons_detected=False, weapon_confidence=0.0, error="No frame provided", detections=[])

            if "," in encoded:
                encoded = encoded.split(",", 1)[1]
            img_data = base64.b64decode(encoded)
            nparr    = np.frombuffer(img_data, np.uint8)
            frame    = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if frame is None:
                return FastVisionResponse(weapons_detected=False, weapon_confidence=0.0, error="Invalid image data", detections=[])

            stream_id = req.stream_id or "default"
            logger.info(f"[DETECT API] Processing single frame for stream {stream_id}")

            # Scan weapons
            max_weapon_conf, _, weapon_detections, _ = self._scan_weapons([frame], *frame.shape[:2])
            weapons_detected = max_weapon_conf >= WEAPON_ALERT_THRESH
            logger.info(f"   -> Weapon Check: max_conf={max_weapon_conf:.3f} (thresh={WEAPON_ALERT_THRESH}) detected={weapons_detected}")

            # Scan persons / pose
            state = self._get_stream_state(stream_id)
            fall_detected, max_fall_conf, person_detections, fall_detections = self._run_pose(frame, state["tracker"])
            logger.info(f"   -> Fall Check: max_conf={max_fall_conf:.3f} detected={fall_detected}")
            for i, d in enumerate(person_detections):
                logger.info(f"   -> Person {i}: conf={d.confidence:.3f} bbox={d.bbox}")

            # ── Roll Frames for Brawl Model in Single-Frame Mode ──
            IMG_SIZE, SEQ_LEN = (84, 84), 20
            if "brawl_buffer" not in state:
                state["brawl_buffer"] = []
            
            resized = cv2.resize(frame, IMG_SIZE)
            rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
            prev_gray = state.get("prev_gray")
            
            if prev_gray is None:
                flow = np.zeros((*IMG_SIZE, 2), dtype=np.float32)
            else:
                flow = _compute_optical_flow(prev_gray, gray)
                flow = np.clip(flow / 20.0, -1.0, 1.0)
            state["prev_gray"] = gray
            
            stacked = np.concatenate([rgb, flow], axis=-1)
            state["brawl_buffer"].append(stacked)
            
            if len(state["brawl_buffer"]) > SEQ_LEN:
                state["brawl_buffer"] = state["brawl_buffer"][-SEQ_LEN:]
            
            violence_detected = False
            violence_confidence = 0.0
            if len(state["brawl_buffer"]) >= 5:
                pad_len = SEQ_LEN - len(state["brawl_buffer"])
                padded_buffer = [np.zeros((*IMG_SIZE, 5), dtype=np.float32)] * pad_len + state["brawl_buffer"]
                sequence = np.expand_dims(np.array(padded_buffer, dtype=np.float32), axis=0)
                raw_brawl_conf = float(self.brawl_model.predict(sequence, verbose=0)[0][0])
                violence_detected = raw_brawl_conf > BRAWL_ALERT_THRESH
                violence_confidence = raw_brawl_conf
                logger.info(f"   -> Violence Check (Buffered): raw_conf={raw_brawl_conf:.3f} (thresh={BRAWL_ALERT_THRESH}) detected={violence_detected}")

            if weapons_detected:
                threat_type = "weapon"
            elif fall_detected:
                threat_type = "fall"
            elif violence_detected:
                threat_type = "violence"
                for d in person_detections:
                    d.detection_type = "violent_person"
            else:
                threat_type = "none"

            all_detections = person_detections + weapon_detections + fall_detections
            logger.info(f"   => FINAL THREAT TYPE: {threat_type.upper()} with {len(all_detections)} detections")
            
            return FastVisionResponse(
                weapons_detected=weapons_detected,
                weapon_confidence=max_weapon_conf,
                violence_detected=violence_detected,
                violence_confidence=violence_confidence,
                fall_detected=fall_detected,
                fall_confidence=max_fall_conf,
                threat_type=threat_type,
                detections=all_detections,
                per_frame_detections={0: all_detections}
            )
        except Exception as e:
            traceback.print_exc()
            return FastVisionResponse(weapons_detected=False, weapon_confidence=0.0, error=str(e), detections=[])