"""
Fall_Detector.py — Aegis Overwatch Fall Detection Engine
=====================================================================
Stage 1: The RADAR (Pose Heuristics)
  - Loads yolo11m-pose.pt and extracts 17-point COCO keypoints every frame.
  - Calculates spine angle and head/ankle proximity.
  - Flags Fall Suspicion using mathematical geometry.

Stage 2: The JUDGE (Custom Verification)
  - If Stage 1 fires, crops the bounding box of the flagged person(s).
  - Runs the cropped patch through fall_best.pt.
  - Only promotes to a CONFIRMED alert if judge confidence > 0.50.

Run:
    python3 Fall_Detector.py              # -> webcam (index 0)
    python3 Fall_Detector.py <video.mp4>  # -> video file
"""

import sys
import math
import time
import numpy as np
import cv2
from ultralytics import YOLO
import os

# ─── MODEL PATHS ──────────────────────────────────────────────────────────────
POSE_MODEL_PATH  = "yolo11m-pose.pt"   # Pre-trained; auto-downloaded if missing
FALL_JUDGE_PATH  = "fall_best.pt"      # Your custom trained fall model

# ─── HEURISTIC THRESHOLDS ─────────────────────────────────────────────────────
# Stage 1: Radar triggers (lenient to avoid missing real events)
FALL_SPINE_ANGLE_DEG  = 45    # Spine angle below this = horizontal → suspicious
FALL_HEAD_ANKLE_FRAC  = 0.15  # head_y within this fraction of ankle_y = fallen

# Stage 2: Judge confirmation threshold
JUDGE_CONFIRM_THRESH  = 0.50

SMOOTHING_FRAMES      = 10    # Number of frames to persist an alert to prevent flickering

class EventTracker:
    def __init__(self, max_age=10):
        self.max_age = max_age
        self.events = []
        
    def update(self, current_events):
        for e in self.events:
            e['age'] += 1
            
        for curr in current_events:
            matched = False
            for e in self.events:
                # Match by exact label prefix and spatial overlap
                if e['label'].split(' ')[1] == curr['label'].split(' ')[1] and bbox_iou(curr['box'], e['box']) > 0.3:
                    e['box'] = curr['box']
                    e['label'] = curr['label']
                    e['age'] = 0
                    matched = True
                    break
            if not matched:
                curr['age'] = 0
                self.events.append(curr)
                
        # Filter out expired events
        self.events = [e for e in self.events if e['age'] < self.max_age]
        
    def get_active(self):
        return self.events

global_tracker = EventTracker(max_age=SMOOTHING_FRAMES)

# Keypoint index map (COCO 17-point skeleton)
NOSE, L_EYE, R_EYE, L_EAR, R_EAR = 0, 1, 2, 3, 4
L_SHOULDER, R_SHOULDER = 5, 6
L_ELBOW, R_ELBOW = 7, 8
L_WRIST, R_WRIST = 9, 10
L_HIP, R_HIP = 11, 12
L_KNEE, R_KNEE = 13, 14
L_ANKLE, R_ANKLE = 15, 16

# ─── LOAD MODELS ─────────────────────────────────────────────────────────────
print("[ Aegis ] Loading Stage 1 Radar  (pose model)...")
radar = YOLO(POSE_MODEL_PATH)

print("[ Aegis ] Loading Stage 2 Judge  (custom models)...")
fall_judge  = None

try:
    fall_judge = YOLO(FALL_JUDGE_PATH)
    print(f"[ Aegis ] ✓ Fall  Judge loaded from {FALL_JUDGE_PATH}")
except Exception as e:
    print(f"[ Aegis ] ⚠  Fall  Judge NOT loaded ({FALL_JUDGE_PATH} missing): {e}")



# ─── GEOMETRY HELPERS ─────────────────────────────────────────────────────────

def kp_xy(kps, idx):
    """Return (x, y) for keypoint `idx`. Returns None if invisible (conf < 0.3)."""
    if kps is None or len(kps) <= idx:
        return None
    x, y, c = float(kps[idx][0]), float(kps[idx][1]), float(kps[idx][2])
    return (x, y) if c > 0.3 else None


def angle_deg(p1, p2):
    """Angle of the line p1→p2 from horizontal, in degrees [-90, 90]."""
    if p1 is None or p2 is None:
        return None
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    return math.degrees(math.atan2(abs(dy), abs(dx) + 1e-6))


def angle_3pt(p1, p2, p3):
    """Angle p1-p2-p3 in degrees [0, 180]."""
    if p1 is None or p2 is None or p3 is None:
        return None
    v1 = (p1[0] - p2[0], p1[1] - p2[1])
    v2 = (p3[0] - p2[0], p3[1] - p2[1])
    mag1, mag2 = math.hypot(*v1), math.hypot(*v2)
    if mag1 * mag2 == 0:
        return None
    val = max(-1.0, min(1.0, (v1[0]*v2[0] + v1[1]*v2[1]) / (mag1 * mag2)))
    return math.degrees(math.acos(val))


def bbox_iou(b1, b2):
    """Intersection-over-Union for two [x1,y1,x2,y2] boxes."""
    ix1, iy1 = max(b1[0], b2[0]), max(b1[1], b2[1])
    ix2, iy2 = min(b1[2], b2[2]), min(b1[3], b2[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    a1 = (b1[2] - b1[0]) * (b1[3] - b1[1])
    a2 = (b2[2] - b2[0]) * (b2[3] - b2[1])
    return inter / (a1 + a2 - inter + 1e-6)

def bbox_intersects(b1, b2):
    """Returns True if the two boxes simply overlap."""
    ix1, iy1 = max(b1[0], b2[0]), max(b1[1], b2[1])
    ix2, iy2 = min(b1[2], b2[2]), min(b1[3], b2[3])
    return ix1 < ix2 and iy1 < iy2


def safe_crop(frame, x1, y1, x2, y2, pad=20):
    """Crop frame with clamped padding."""
    h, w = frame.shape[:2]
    x1 = max(0, x1 - pad)
    y1 = max(0, y1 - pad)
    x2 = min(w, x2 + pad)
    y2 = min(h, y2 + pad)
    if x2 <= x1 or y2 <= y1:
        return None
    return frame[y1:y2, x1:x2]


# ─── STAGE 1: RADAR (HEURISTIC) ───────────────────────────────────────────────

def check_fall_suspicion(kps, bbox):
    """
    Returns True if the keypoint geometry suggests a fall.
    Two independent signals; either one is enough to flag:
      A) Spine angle ≤ FALL_SPINE_ANGLE_DEG (person horizontal)
      B) Head Y-coord is close to ankle Y-coord (person collapsed)
    """
    # Estimate "neck" as midpoint of shoulders
    ls = kp_xy(kps, L_SHOULDER)
    rs = kp_xy(kps, R_SHOULDER)
    lh = kp_xy(kps, L_HIP)
    rh = kp_xy(kps, R_HIP)

    neck  = ((ls[0]+rs[0])/2, (ls[1]+rs[1])/2) if (ls and rs) else None
    mhip  = ((lh[0]+rh[0])/2, (lh[1]+rh[1])/2) if (lh and rh) else None

    # Signal A — spine near horizontal
    sp_angle = angle_deg(neck, mhip)
    if sp_angle is not None and sp_angle < FALL_SPINE_ANGLE_DEG:
        return True, f"Spine {sp_angle:.0f}°"

    # Signal B — head (nose) near ankle level
    head  = kp_xy(kps, NOSE)
    la    = kp_xy(kps, L_ANKLE)
    ra    = kp_xy(kps, R_ANKLE)
    ankle = la or ra
    if head and ankle:
        bbox_h = bbox[3] - bbox[1] + 1e-6
        if abs(head[1] - ankle[1]) / bbox_h < FALL_HEAD_ANKLE_FRAC:
            return True, "Head≈Ankle"

    return False, ""



# ─── STAGE 2: JUDGE (CUSTOM MODEL VERIFICATION) ──────────────────────────────

def run_judge(judge_model, frame, x1, y1, x2, y2):
    """
    Crops the person from frame and runs through the judge model.
    Returns (confirmed: bool, confidence: float).
    """
    crop = safe_crop(frame, x1, y1, x2, y2)
    if crop is None or crop.size == 0:
        return False, 0.0

    results = judge_model.predict(
        source=crop,
        device='mps',
        half=False,
        conf=JUDGE_CONFIRM_THRESH,
        verbose=False
    )
    if results[0].boxes is not None and len(results[0].boxes) > 0:
        best_conf = float(results[0].boxes.conf.max())
        return best_conf >= JUDGE_CONFIRM_THRESH, best_conf
    return False, 0.0


# ─── DRAW UTILITIES ──────────────────────────────────────────────────────────

ALERT_COLOR    = (0,   0,   255)  # Red
SUSPICION_COLOR= (0,  165,  255)  # Orange
SAFE_COLOR     = (0,  200,   80)  # Green

def draw_status_bar(frame, alerts):
    """Renders a top status banner."""
    h, w = frame.shape[:2]
    bar_h = 50
    overlay = frame.copy()
    if alerts:
        cv2.rectangle(overlay, (0, 0), (w, bar_h), (0, 0, 200), -1)
    else:
        cv2.rectangle(overlay, (0, 0), (w, bar_h), (30, 30, 30), -1)
    cv2.addWeighted(overlay, 0.7, frame, 0.3, 0, frame)

    msg = "  |  ".join(alerts) if alerts else "AEGIS OVERWATCH — ALL CLEAR"
    color = (255, 80, 80) if alerts else (80, 255, 120)
    cv2.putText(frame, msg, (12, 33), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)
    return frame


def draw_box(frame, x1, y1, x2, y2, label, color):
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
    lbl_y = max(y1 - 8, 20)
    cv2.putText(frame, label, (x1, lbl_y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)


# ─── MAIN PROCESSING LOOP ─────────────────────────────────────────────────────

def process_frame(frame, return_alerts=False):
    """
    Full two-stage cascade on a single BGR frame.
    Returns the annotated BGR frame.
    """
    alerts   : list[str] = []
    confirmed_events: list[tuple] = []  # (x1,y1,x2,y2, label)

    # ── Stage 1: Radar ──────────────────────────────────────────────────────
    results = radar.predict(
        source=frame,
        device='mps',
        half=True,
        imgsz=640,
        conf=0.40,
        verbose=False
    )

    res = results[0]
    if res.boxes is None or len(res.boxes) == 0:
        if return_alerts:
            return draw_status_bar(frame, []), []
        return draw_status_bar(frame, [])

    boxes_xyxy = [[int(v) for v in b.tolist()] for b in res.boxes.xyxy]
    keypoints_list = []
    if res.keypoints is not None and res.keypoints.data is not None:
        for kp_tensor in res.keypoints.data:
            keypoints_list.append(kp_tensor.cpu().numpy())
    else:
        keypoints_list = [None] * len(boxes_xyxy)

    fall_suspects  : list[tuple] = []   # (person_idx, reason)

    # --- Check falls per person ----------------------------------------------
    for idx, (bbox, kps) in enumerate(zip(boxes_xyxy, keypoints_list)):
        fall, reason = check_fall_suspicion(kps, bbox)
        if fall:
            fall_suspects.append((idx, reason))


    # ── Draw lightweight skeleton (all persons) ──────────────────────────────
    skeleton_pairs = [
        (L_SHOULDER, R_SHOULDER), (L_HIP, R_HIP),
        (L_SHOULDER, L_HIP), (R_SHOULDER, R_HIP),
        (L_SHOULDER, L_ELBOW), (L_ELBOW, L_WRIST),
        (R_SHOULDER, R_ELBOW), (R_ELBOW, R_WRIST),
        (L_HIP, L_KNEE), (L_KNEE, L_ANKLE),
        (R_HIP, R_KNEE), (R_KNEE, R_ANKLE),
        (NOSE, L_SHOULDER), (NOSE, R_SHOULDER),
    ]
    for kps in keypoints_list:
        if kps is None:
            continue
        for a, b in skeleton_pairs:
            pa, pb = kp_xy(kps, a), kp_xy(kps, b)
            if pa and pb:
                cv2.line(frame, (int(pa[0]), int(pa[1])), (int(pb[0]), int(pb[1])), (180, 180, 180), 1)

    # ── Stage 2: Judge ───────────────────────────────────────────────────────
    all_flagged = {idx for idx, _ in fall_suspects}
    current_events = []

    # FALL JUDGE
    for (idx, reason) in fall_suspects:
        bbox = boxes_xyxy[idx]
        x1, y1, x2, y2 = bbox

        if fall_judge is not None:
            confirmed, conf_val = run_judge(fall_judge, frame, x1, y1, x2, y2)
        else:
            confirmed, conf_val = False, 0.0

        if confirmed:
            label = f"🚨 CONFIRMED FALL {conf_val:.2f}"
            current_events.append({'box': [x1, y1, x2, y2], 'label': label, 'color': ALERT_COLOR})
        elif fall_judge is None:
            label = f"⚠ Fall Suspected ({reason})"
            current_events.append({'box': [x1, y1, x2, y2], 'label': label, 'color': SUSPICION_COLOR})

    # Update global smoothing tracker
    global_tracker.update(current_events)
    
    # Draw all temporally smoothed events
    active_alerts = set()
    tracked_boxes = []
    for ev in global_tracker.get_active():
        b = ev['box']
        draw_box(frame, b[0], b[1], b[2], b[3], ev['label'], ev['color'])
        active_alerts.add(ev['label'])
        tracked_boxes.append(b)

    # Draw safe persons (no suspicion)
    for idx, bbox in enumerate(boxes_xyxy):
        # Only draw safe if it doesn't heavily overlap a smoothed alert box
        is_safe = True
        for tb in tracked_boxes:
            if bbox_iou(bbox, tb) > 0.5:
                is_safe = False
                break
        if is_safe:
            draw_box(frame, bbox[0], bbox[1], bbox[2], bbox[3], "person", SAFE_COLOR)

    if return_alerts:
        return draw_status_bar(frame, list(active_alerts)), list(active_alerts)
    return draw_status_bar(frame, list(active_alerts))


# ─── ENTRY POINT ─────────────────────────────────────────────────────────────

def main():
    source = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else \
             sys.argv[1] if len(sys.argv) > 1 else 0

    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"[ Aegis ] ERROR: Could not open source: {source}")
        sys.exit(1)

    print(f"[ Aegis ] Engine hot. Source: {source}  |  Press 'q' to quit.")

    fps_timer = time.time()
    frame_count = 0

    # Mac camera warmup
    if source == 0:
        time.sleep(1)

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        annotated = process_frame(frame)

        # FPS overlay
        frame_count += 1
        elapsed = time.time() - fps_timer
        if elapsed >= 1.0:
            fps = frame_count / elapsed
            frame_count = 0
            fps_timer = time.time()
            cv2.putText(annotated, f"FPS: {fps:.1f}", (10, annotated.shape[0] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

        cv2.imshow("Aegis Overwatch — Hybrid Engine", annotated)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            print("[ Aegis ] Manual exit via 'q'.")
            break

    cap.release()
    cv2.destroyAllWindows()
    print("[ Aegis ] Engine shut down cleanly.")


if __name__ == "__main__":
    main()
