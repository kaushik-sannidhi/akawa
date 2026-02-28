from ultralytics import YOLO
import os
import torch

# Weapon classes from both datasets that should trigger alerts
# merged_dataset: rifle, handgun, knife
# Master_Weapon_Dataset: weapon
WEAPON_CLASSES = {"rifle", "handgun", "knife", "weapon"}


class WeaponDetector:
    def __init__(self, model_path=None):
        """
        Initializes the YOLO-based weapon detector.
        If model_path is a directory name under runs/detect, loads from there.
        Otherwise auto-discovers the latest fine-tuned model, or falls back to yolo11m.pt.
        """
        resolved_path = self._resolve_model_path(model_path)

        self.use_half = torch.cuda.is_available()

        try:
            print(f"[WeaponDetector] Loading YOLO model from {resolved_path}")
            self.model = YOLO(resolved_path)
            if torch.cuda.is_available():
                self.model.to("cuda")
                print(f"[WeaponDetector] Model loaded on GPU (CUDA) with FP16={self.use_half}")
            else:
                print(f"[WeaponDetector] CUDA not available, running on CPU")
        except Exception as e:
            print(f"[WeaponDetector] Failed to load {resolved_path}: {e}")
            fallback = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "yolo11m.pt")
            print(f"[WeaponDetector] Falling back to {fallback}")
            self.model = YOLO(fallback)
            if torch.cuda.is_available():
                self.model.to("cuda")

    def _resolve_model_path(self, model_path):
        """Resolves a model path from an ID or finds the latest one."""
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        runs_dir = os.path.join(project_root, "runs", "detect")

        # If it's a specific run name (e.g. "weapon_detector" or "train_weapons_sanity")
        if model_path and model_path not in (None, "latest"):
            specific = os.path.join(runs_dir, model_path, "weights", "best.pt")
            if os.path.exists(specific):
                print(f"[WeaponDetector] Using specific model: {specific}")
                return specific
            # Also check if it's a direct path
            if os.path.exists(model_path):
                return model_path

        # Auto-discover latest
        latest = self._get_latest_trained_model()
        if latest:
            return latest

        # Fallback to base model
        return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "yolo11m.pt")

    def _get_latest_trained_model(self):
        """Scans the runs/detect directory to find the most recently trained weights."""
        runs_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "runs", "detect")
        if not os.path.exists(runs_dir):
            return None

        subdirs = [os.path.join(runs_dir, d) for d in os.listdir(runs_dir) if os.path.isdir(os.path.join(runs_dir, d))]
        if not subdirs:
            return None

        subdirs.sort(key=lambda x: os.path.getmtime(x), reverse=True)

        for folder in subdirs:
            best_pt_path = os.path.join(folder, "weights", "best.pt")
            if os.path.exists(best_pt_path):
                print(f"[WeaponDetector] Found fine-tuned model: {best_pt_path}")
                return best_pt_path

        return None

    @staticmethod
    def list_available_models():
        """Lists all available trained models from runs/detect/."""
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        runs_dir = os.path.join(project_root, "runs", "detect")
        models = []

        # Always include "latest" as auto-select option
        models.append({"id": "latest", "name": "Latest (Auto-Select)"})

        if os.path.exists(runs_dir):
            for d in sorted(os.listdir(runs_dir)):
                full = os.path.join(runs_dir, d)
                if os.path.isdir(full):
                    best = os.path.join(full, "weights", "best.pt")
                    if os.path.exists(best):
                        # Read args.yaml for metadata if available
                        label = d.replace("_", " ").title()
                        models.append({"id": d, "name": label})

        return models

    @torch.inference_mode()
    def process_frame(self, frame):
        """
        Runs YOLO inference on a single frame with max speed optimizations.
        Returns a list of detection dicts with normalized bounding boxes.
        """
        results = self.model.track(
            frame,
            verbose=False,
            half=self.use_half,
            imgsz=448,
            persist=True,
            tracker="botsort.yaml",
            agnostic_nms=True,
            max_det=20,
        )

        detections = []
        names = self.model.names
        for r in results:
            boxes = r.boxes
            if boxes is None or len(boxes) == 0:
                continue

            # Vectorised tensor access — pull all at once, then iterate on CPU
            confs = boxes.conf.cpu().numpy()
            clss = boxes.cls.cpu().int().numpy()
            xyxyn = boxes.xyxyn.cpu().numpy()
            ids = boxes.id.cpu().int().numpy() if boxes.id is not None else None

            for i in range(len(confs)):
                conf = float(confs[i])
                if conf < 0.20:
                    continue
                cls_id = int(clss[i])
                nx1, ny1, nx2, ny2 = float(xyxyn[i][0]), float(xyxyn[i][1]), float(xyxyn[i][2]), float(xyxyn[i][3])
                track_id = int(ids[i]) if ids is not None else None
                cls_name = names.get(cls_id, f"class_{cls_id}").lower()

                detections.append({
                    "id": f"det_{track_id}" if track_id else f"det_{cls_id}_{nx1:.2f}_{ny1:.2f}",
                    "track_id": track_id,
                    "class_id": cls_id,
                    "class_name": cls_name,
                    "confidence": round(conf, 3),
                    "is_weapon": cls_name in WEAPON_CLASSES,
                    "bbox": {
                        "x1": nx1,
                        "y1": ny1,
                        "x2": nx2,
                        "y2": ny2,
                    },
                })

        return detections

    @torch.inference_mode()
    def process_batch(self, frames):
        """
        Batch inference: process multiple frames at once for GPU efficiency.
        Returns a list of per-frame detection lists.
        """
        all_detections = []

        results = self.model.track(
            frames,
            verbose=False,
            half=self.use_half,
            imgsz=448,
            persist=True,
            tracker="botsort.yaml",
            agnostic_nms=True,
            max_det=20,
        )

        names = self.model.names
        for r in results:
            frame_dets = []
            boxes = r.boxes
            if boxes is None or len(boxes) == 0:
                all_detections.append(frame_dets)
                continue

            confs = boxes.conf.cpu().numpy()
            clss = boxes.cls.cpu().int().numpy()
            xyxyn = boxes.xyxyn.cpu().numpy()
            ids = boxes.id.cpu().int().numpy() if boxes.id is not None else None

            for i in range(len(confs)):
                conf = float(confs[i])
                if conf < 0.20:
                    continue
                cls_id = int(clss[i])
                nx1, ny1, nx2, ny2 = float(xyxyn[i][0]), float(xyxyn[i][1]), float(xyxyn[i][2]), float(xyxyn[i][3])
                track_id = int(ids[i]) if ids is not None else None
                cls_name = names.get(cls_id, f"class_{cls_id}").lower()

                frame_dets.append({
                    "id": f"det_{track_id}" if track_id else f"det_{cls_id}_{nx1:.2f}_{ny1:.2f}",
                    "track_id": track_id,
                    "class_id": cls_id,
                    "class_name": cls_name,
                    "confidence": round(conf, 3),
                    "is_weapon": cls_name in WEAPON_CLASSES,
                    "bbox": {
                        "x1": nx1,
                        "y1": ny1,
                        "x2": nx2,
                        "y2": ny2,
                    },
                })
            all_detections.append(frame_dets)

        return all_detections
