import os
import modal

app = modal.App("akawa-ai")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "ultralytics",
        "opencv-python-headless",
        "fastapi",
        "pydantic",
        "numpy",
        "torch",
        "torchvision"
    )
    .add_local_file(os.path.join(os.path.dirname(__file__), "best.pt"), remote_path="/model/best.pt")
)

WEAPON_CLASSES = {"rifle", "handgun", "knife", "weapon"}

@app.cls(gpu="T4", image=image)
class WeaponAPI:
    @modal.enter()
    def setup(self):
        from ultralytics import YOLO
        import torch
        print("Loading YOLO model on GPU")
        self.use_half = torch.cuda.is_available()
        self.model = YOLO("/model/best.pt")
        if self.use_half:
            self.model.to("cuda")

    def _decode(self, b64_str):
        import base64
        import numpy as np
        import cv2

        if "," in b64_str:
            _, encoded = b64_str.split(",", 1)
        else:
            encoded = b64_str
        try:
            img_data = base64.b64decode(encoded)
            nparr = np.frombuffer(img_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            return frame
        except Exception as e:
            print(f"Error decoding image: {e}")
            return np.zeros((448, 448, 3), dtype=np.uint8)

    @modal.web_endpoint(method="POST")
    def predict(self, item: dict):
        # item expects {"image": "base64...", "is_batch": false, "images": []}
        is_batch = item.get("is_batch", False)
        
        frames = []
        if is_batch:
            b64_list = item.get("images", [])
            for b64 in b64_list:
                frames.append(self._decode(b64))
        else:
            frames.append(self._decode(item.get("image", "")))

        # Inference
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

        all_detections = []
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

        if is_batch:
            return {"detections": all_detections}
        else:
            return {"detections": all_detections[0] if all_detections else []}
