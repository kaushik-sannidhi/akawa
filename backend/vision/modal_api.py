"""
Akawa Vision Threat Detection API — Modal Deployment

Endpoint:
  1. Qwen2VLModel — VLM-based deep visual analysis (4x A100 GPUs, PyTorch)

Deploy:  modal deploy akawa/backend/vision/modal_api.py
Download weights once:  modal run akawa/backend/vision/modal_api.py::download_model
"""

import modal
from pydantic import BaseModel
from typing import Dict, List, Optional

# ═══════════════════════════════════════════════════════════════════════════════
# Modal App
# ═══════════════════════════════════════════════════════════════════════════════
app = modal.App("akawa-vlm-api")

# ═══════════════════════════════════════════════════════════════════════════════
# ENDPOINT — Qwen2-VL Deep Analysis (4x A100 GPUs)
# ═══════════════════════════════════════════════════════════════════════════════

# ── Image ────────────────────────────────────────────────────────────────────
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
        "pillow"
    )
)

# ── Volume for Qwen2-VL model weights ───────────────────────────────────────
qwen2_vl_volume = modal.Volume.from_name("qwen2-vl-7b-weights", create_if_missing=True)
QWEN2_VL_MODEL_DIR = "/model_cache"
QWEN2_VL_MODEL_ID  = "Qwen/Qwen2-VL-7B-Instruct"

# ── Helper: pre-download Qwen2-VL weights ───────────────────────────────────
@app.function(image=qwen2_vl_image, volumes={QWEN2_VL_MODEL_DIR: qwen2_vl_volume}, timeout=7200)
def download_model():
    from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
    import torch
    
    print(f"Downloading model {QWEN2_VL_MODEL_ID} to volume {QWEN2_VL_MODEL_DIR}...")
    
    # We download the fp16/bf16 weights. Due to 140GB size, this will take some time.
    AutoProcessor.from_pretrained(QWEN2_VL_MODEL_ID, cache_dir=QWEN2_VL_MODEL_DIR)
    Qwen2VLForConditionalGeneration.from_pretrained(
        QWEN2_VL_MODEL_ID, 
        device_map="auto", 
        torch_dtype=torch.bfloat16, 
        cache_dir=QWEN2_VL_MODEL_DIR
    )
    
    print("Done downloading.")
    qwen2_vl_volume.commit()


# ── Pydantic schemas for the Qwen2-VL endpoint ──────────────────────────────
class Qwen2VLRequest(BaseModel):
    video_b64: str  # Base64 encoded video string (without data:video/mp4;base64, prefix)
    prompt: Optional[str] = "You are a specialized security analyst. Your goal is to provide a detailed, objective description of every person in the video and their exact physical actions. For each person, describe their clothing, appearance, and what they are doing to others or the environment. Focus on physical interactions: grappling, punching, grabbing, struggling, dragging, or protective stances. Describe exactly who is doing what to whom in high detail."

class Qwen2VLResponse(BaseModel):
    text: str
    error: Optional[str] = None


# Require 1 A100 for the 7B model and keep 1 replica warm to avoid cold starts
@app.cls(
    image=qwen2_vl_image, 
    gpu="A100", 
    volumes={QWEN2_VL_MODEL_DIR: qwen2_vl_volume}, 
    min_containers=1,
    timeout=300
)
class Qwen2VLModel:
    """
    Qwen2-VL-7B-Instruct for deep visual reasoning.
    Runs on 1x A100 GPU constantly warm.
    """

    @modal.enter()
    def load_model(self):
        import torch
        from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
        
        print("Loading Qwen2-VL-7B model on 1x A100 GPU...")
        self.processor = AutoProcessor.from_pretrained(QWEN2_VL_MODEL_ID, cache_dir=QWEN2_VL_MODEL_DIR)
        
        # Load the model directly to the GPU.
        self.model = Qwen2VLForConditionalGeneration.from_pretrained(
            QWEN2_VL_MODEL_ID,
            device_map="auto",
            torch_dtype=torch.bfloat16,
            cache_dir=QWEN2_VL_MODEL_DIR,
        )
        self.model.eval()
        print("Qwen2-VL model loaded successfully.")

    @modal.fastapi_endpoint(method="POST", docs=True)
    def analyze(self, req: Qwen2VLRequest) -> Qwen2VLResponse:
        import base64
        import torch
        import traceback
        import tempfile
        import os
        from qwen_vl_utils import process_vision_info

        temp_video_path = None
        try:
            # Decode the base64 video
            video_bytes = base64.b64decode(req.video_b64)
            
            # Write to a temporary file
            fd, temp_video_path = tempfile.mkstemp(suffix=".mp4")
            with os.fdopen(fd, 'wb') as f:
                f.write(video_bytes)

            # Prepare the conversation
            messages = [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "video",
                            "video": temp_video_path,
                            "max_pixels": 250880,
                            "fps": 5.0,
                        },
                        {"type": "text", "text": req.prompt},
                    ],
                }
            ]

            # Use processor to format for Qwen2-VL
            text = self.processor.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            image_inputs, video_inputs = process_vision_info(messages)
            
            inputs = self.processor(
                text=[text],
                images=image_inputs,
                videos=video_inputs,
                padding=True,
                return_tensors="pt",
            ).to(self.model.device)

            # Generate output
            with torch.no_grad():
                generated_ids = self.model.generate(**inputs, max_new_tokens=500)

            # Trim the prompt from the output
            generated_ids_trimmed = [
                out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
            ]
            
            output_text = self.processor.batch_decode(
                generated_ids_trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
            )[0]

            return Qwen2VLResponse(text=output_text.strip())

        except Exception as e:
            traceback.print_exc()
            return Qwen2VLResponse(text="", error=str(e))
            
        finally:
            if temp_video_path and os.path.exists(temp_video_path):
                try:
                    os.remove(temp_video_path)
                except Exception:
                    pass

# ═══════════════════════════════════════════════════════════════════════════════
# ENDPOINT — Fast Vision (Weapon + Violence Detection on T4 GPU)
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
        "torch>=2.0.0" # ultralytics needs torch
    )
    .add_local_dir(
        "akawa/backend/vision/models",
        remote_path="/root/models"
    )
)

class FastVisionRequest(BaseModel):
    video_b64: str

class FastVisionResponse(BaseModel):
    weapons_detected: bool
    weapon_confidence: float
    violence_detected: bool
    violence_confidence: float
    error: Optional[str] = None

@app.cls(
    image=fast_vision_image,
    gpu="A100", # T4 or L4 is enough for YOLO + TwoStream
    min_containers=1,
    timeout=300
)
class FastVisionAPI:
    """
    Fast Vision API that quickly identifies weapons (YOLO) and brawling/violence (Two-Stream).
    Runs on 1x T4 GPU constantly warm.
    """

    @modal.enter()
    def load_models(self):
        import tensorflow as tf
        import torch
        from ultralytics import YOLO
        import ultralytics.nn.tasks
        import os
        
        print("Loading Fast Vision Models...")
        
        # Patch for PyTorch 2.6 weights_only=True default breaking Ultralytics loads
        try:
            torch.serialization.add_safe_globals([ultralytics.nn.tasks.DetectionModel])
        except AttributeError:
            pass # Older PyTorch versions don't need this
        
        # Load YOLO Weapon model
        self.weapon_model = YOLO('/root/models/weapon.pt')
        
        # Load Two-Stream Violence model
        self.brawl_model = tf.keras.models.load_model('/root/models/brawl_model.keras')
        
        print("Fast Vision Models loaded successfully.")

    @modal.fastapi_endpoint(method="POST", docs=True)
    def analyze(self, req: FastVisionRequest) -> FastVisionResponse:
        import base64
        import cv2
        import numpy as np
        import tempfile
        import os
        import traceback

        temp_video_path = None
        try:
            # Decode the base64 video
            video_bytes = base64.b64decode(req.video_b64)
            
            # Write to a temporary file
            fd, temp_video_path = tempfile.mkstemp(suffix=".mp4")
            with os.fdopen(fd, 'wb') as f:
                f.write(video_bytes)

            cap = cv2.VideoCapture(temp_video_path)
            
            # Configuration
            SEQ_LEN = 20
            IMG_SIZE = (84, 84)
            
            frame_buffer = []
            prev_gray = None
            
            brawl_confidences = []
            weapon_confidences = []
            
            def compute_optical_flow(prev, curr):
                flow = cv2.calcOpticalFlowFarneback(
                    prev, curr, None, 
                    pyr_scale=0.5, levels=3, winsize=15, 
                    iterations=5, poly_n=5, poly_sigma=1.1, flags=0
                )
                return flow
            
            frame_count = 0
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                    
                frame_count += 1
                
                # --- 1. Weapon Detection (YOLO) ---
                # Run weapon detection on every 5th frame to save compute
                if frame_count % 5 == 0:
                    results = self.weapon_model(frame, verbose=False)
                    for r in results:
                        # Check confidence of detections
                        if len(r.boxes.conf) > 0:
                            max_conf = float(r.boxes.conf.max().cpu().numpy())
                            weapon_confidences.append(max_conf)
                
                # --- 2. Violence Detection (Two-Stream) ---
                resized_frame = cv2.resize(frame, IMG_SIZE)
                rgb = cv2.cvtColor(resized_frame, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
                gray = cv2.cvtColor(resized_frame, cv2.COLOR_BGR2GRAY)
                
                if prev_gray is None:
                    flow = np.zeros((*IMG_SIZE, 2), dtype=np.float32)
                else:
                    flow = compute_optical_flow(prev_gray, gray)
                    flow = np.clip(flow / 20.0, -1.0, 1.0)
                    
                prev_gray = gray
                
                stacked_5c = np.concatenate([rgb, flow], axis=-1)
                frame_buffer.append(stacked_5c)
                
                # Keep sliding window of size SEQ_LEN
                if len(frame_buffer) > SEQ_LEN:
                    frame_buffer.pop(0)
                
                if len(frame_buffer) == SEQ_LEN:
                    sequence = np.array(frame_buffer, dtype=np.float32)
                    sequence = np.expand_dims(sequence, axis=0) # Shape: (1, 20, 84, 84, 5)
                    prob = float(self.brawl_model.predict(sequence, verbose=0)[0][0])
                    brawl_confidences.append(prob)

            cap.release()
            
            # Aggregation logic
            max_weapon_conf = max(weapon_confidences) if weapon_confidences else 0.0
            weapons_detected = max_weapon_conf > 0.5 # Threshold for weapon
            
            max_brawl_conf = max(brawl_confidences) if brawl_confidences else 0.0
            violence_detected = max_brawl_conf > 0.6 # Threshold from test script

            return FastVisionResponse(
                weapons_detected=weapons_detected,
                weapon_confidence=max_weapon_conf,
                violence_detected=violence_detected,
                violence_confidence=max_brawl_conf
            )

        except Exception as e:
            traceback.print_exc()
            return FastVisionResponse(
                weapons_detected=False,
                weapon_confidence=0.0,
                violence_detected=False,
                violence_confidence=0.0,
                error=str(e)
            )
            
        finally:
            if temp_video_path and os.path.exists(temp_video_path):
                try:
                    os.remove(temp_video_path)
                except Exception:
                    pass

