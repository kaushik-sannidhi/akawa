import math
import cv2
import numpy as np
import os
from ultralytics import YOLO

# Keypoint index map (COCO 17-point skeleton)
NOSE, L_EYE, R_EYE, L_EAR, R_EAR = 0, 1, 2, 3, 4
L_SHOULDER, R_SHOULDER = 5, 6
L_ELBOW, R_ELBOW = 7, 8
L_WRIST, R_WRIST = 9, 10
L_HIP, R_HIP = 11, 12
L_KNEE, R_KNEE = 13, 14
L_ANKLE, R_ANKLE = 15, 16

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

class FallDetector:
    def __init__(self, 
                 pose_model_path="backend/vision/models/yolo11m-pose.pt", 
                 fall_judge_path="backend/vision/models/fall_best.pt"):
        print(f"[ FallDetector ] Initializing with {pose_model_path} and {fall_judge_path}")
        
        # Adjust paths if needed
        # __file__ is /.../backend/vision/fall_detection.py
        vision_dir = os.path.dirname(os.path.abspath(__file__))
        backend_dir = os.path.dirname(vision_dir)
        
        if not os.path.isabs(pose_model_path):
            # If path starts with backend/vision/models/, we need to strip it or just use backend_dir
            model_rel = pose_model_path.split("vision/")[-1] 
            pose_model_path = os.path.join(vision_dir, model_rel)
            
        if not os.path.isabs(fall_judge_path):
            model_rel = fall_judge_path.split("vision/")[-1]
            fall_judge_path = os.path.join(vision_dir, model_rel)

        self.radar = YOLO(pose_model_path)
        self.fall_judge = None
        try:
            self.fall_judge = YOLO(fall_judge_path)
            print(f"[ FallDetector ] ✓ Fall Judge loaded")
        except Exception as e:
            print(f"[ FallDetector ] ⚠ Fall Judge NOT loaded: {e}")

        # Thresholds
        self.FALL_SPINE_ANGLE_DEG = 45
        self.FALL_HEAD_ANKLE_FRAC = 0.15
        self.JUDGE_CONFIRM_THRESH = 0.50
        self.tracker = EventTracker(max_age=10)

    def _check_suspicion(self, kps, bbox):
        ls = kp_xy(kps, L_SHOULDER)
        rs = kp_xy(kps, R_SHOULDER)
        lh = kp_xy(kps, L_HIP)
        rh = kp_xy(kps, R_HIP)

        neck = ((ls[0]+rs[0])/2, (ls[1]+rs[1])/2) if (ls and rs) else None
        mhip = ((lh[0]+rh[0])/2, (lh[1]+rh[1])/2) if (lh and rh) else None

        # Signal A — spine near horizontal
        sp_angle = angle_deg(neck, mhip)
        if sp_angle is not None and sp_angle < self.FALL_SPINE_ANGLE_DEG:
            return True, f"Spine {sp_angle:.0f}°"

        # Signal B — head (nose) near ankle level
        head  = kp_xy(kps, NOSE)
        la    = kp_xy(kps, L_ANKLE)
        ra    = kp_xy(kps, R_ANKLE)
        ankle = la or ra
        if head and ankle:
            bbox_h = bbox[3] - bbox[1] + 1e-6
            if abs(head[1] - ankle[1]) / bbox_h < self.FALL_HEAD_ANKLE_FRAC:
                return True, "Head≈Ankle"

        return False, ""

    def _run_judge(self, frame, bbox):
        x1, y1, x2, y2 = bbox
        h, w = frame.shape[:2]
        pad = 20
        x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
        x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
        
        crop = frame[y1:y2, x1:x2]
        if crop is None or crop.size == 0:
            return False, 0.0

        # Note: 'mps' for Mac, fall back to 'cpu' if needed
        device = 'mps' if cv2.ocl.haveOpenCL() else 'cpu' 
        
        results = self.fall_judge.predict(
            source=crop,
            device=device,
            conf=self.JUDGE_CONFIRM_THRESH,
            verbose=False
        )
        if results[0].boxes is not None and len(results[0].boxes) > 0:
            best_conf = float(results[0].boxes.conf.max())
            return best_conf >= self.JUDGE_CONFIRM_THRESH, best_conf
        return False, 0.0

    def detect(self, frame):
        """
        Returns a list of project-standard detection dicts.
        """
        detections = []
        
        # Stage 1: Radar (Pose)
        device = 'mps' if cv2.ocl.haveOpenCL() else 'cpu'
        results = self.radar.predict(
            source=frame,
            device=device,
            half=True if device == 'mps' else False,
            imgsz=640,
            conf=0.40,
            verbose=False
        )

        res = results[0]
        if res.boxes is None or len(res.boxes) == 0:
            self.tracker.update([])
            return []

        boxes_xyxy = [[int(v) for v in b.tolist()] for b in res.boxes.xyxy]
        keypoints_list = []
        if res.keypoints is not None and res.keypoints.data is not None:
            for kp_tensor in res.keypoints.data:
                keypoints_list.append(kp_tensor.cpu().numpy())
        else:
            keypoints_list = [None] * len(boxes_xyxy)

        current_events = []
        for idx, (bbox, kps) in enumerate(zip(boxes_xyxy, keypoints_list)):
            suspicious, reason = self._check_suspicion(kps, bbox)
            if suspicious:
                confirmed = False
                conf_val = 0.0
                if self.fall_judge:
                    confirmed, conf_val = self._run_judge(frame, bbox)
                
                if confirmed or (not self.fall_judge):
                    label = f"🚨 CONFIRMED FALL {conf_val:.2f}" if confirmed else f"⚠ Fall Suspected ({reason})"
                    current_events.append({
                        'box': bbox, 
                        'label': label
                    })

        self.tracker.update(current_events)
        
        # Standardize for output
        h, w = frame.shape[:2]
        for ev in self.tracker.get_active():
            b = ev['box']
            # xyxyn normalization
            bbox_norm = {"x1": b[0]/w, "y1": b[1]/h, "x2": b[2]/w, "y2": b[3]/h}

            # Extract confidence from label if present
            conf = 0.85
            if "CONFIRMED" in ev['label']:
                try:
                    conf = float(ev['label'].split(' ')[-1])
                except: pass

            detections.append({
                "class_name": "fall",
                "confidence": conf,
                "bbox": bbox_norm,
                "is_weapon": True # Trigger alert UI
            })

        return detections
