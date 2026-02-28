"""
Akawa Audio Threat Detection API — Modal Deployment

Two independent endpoints in one Modal App:
  1. ReyvazDetector  — LSTM/GRU instant acoustic classifier (CPU, TensorFlow)
  2. Qwen2AudioModel — LLM-based deep audio analysis (A100 GPU, PyTorch)

Deploy:  modal deploy akawa/backend/audio/modal_api.py
Upload Reyvaz weights once:  modal run akawa/backend/audio/modal_api.py::upload_reyvaz_model
"""

import modal
from pydantic import BaseModel
from typing import Dict, List, Optional

# ═══════════════════════════════════════════════════════════════════════════════
# Modal App
# ═══════════════════════════════════════════════════════════════════════════════
app = modal.App("akawa-audio-api")

# ═══════════════════════════════════════════════════════════════════════════════
# ENDPOINT 1 — Reyvaz LSTM Detector (CPU)
# ═══════════════════════════════════════════════════════════════════════════════

# ── Image ────────────────────────────────────────────────────────────────────
reyvaz_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "tensorflow>=2.15.0",
        "tf_keras",
        "librosa==0.10.2.post1",
        "numpy",
        "h5py",
        "soundfile==0.12.1",
        "fastapi[standard]",
        "pydantic",
    )
)

# ── Volume for the .h5 model weights ─────────────────────────────────────────
reyvaz_volume = modal.Volume.from_name("reyvaz-model-weights", create_if_missing=True)
REYVAZ_MODEL_DIR = "/reyvaz_model"
REYVAZ_MODEL_FILE = "sed2_trained.h5"

# ── Helper: upload the model weights to the volume ───────────────────────────
@app.function(image=reyvaz_image, volumes={REYVAZ_MODEL_DIR: reyvaz_volume}, timeout=600)
def upload_reyvaz_model():
    """
    Upload sed2_trained.h5 to the Modal volume.
    Run once:  modal run akawa/backend/audio/modal_api.py::upload_reyvaz_model
    
    Downloads from the GitHub repo if not provided locally.
    """
    import os
    import urllib.request

    dest = os.path.join(REYVAZ_MODEL_DIR, REYVAZ_MODEL_FILE)
    if os.path.isfile(dest):
        print(f"Model already exists at {dest}, skipping download.")
        return

    url = "https://github.com/reyvaz/Multiple-Sound-Event-Detection/raw/master/sed2_trained.h5"
    print(f"Downloading {url} ...")
    urllib.request.urlretrieve(url, dest)
    print(f"Saved to {dest} ({os.path.getsize(dest)} bytes)")
    reyvaz_volume.commit()


# ── Reyvaz config constants (inlined from test/reyvaz_detector/config.py) ────
REYVAZ_SAMPLE_RATE   = 44_100
REYVAZ_TRACK_DURATION = 10.0
REYVAZ_MEL_POWER     = 0.5
REYVAZ_TX            = 862       # input time steps
REYVAZ_N_FREQ        = 128       # mel bins
REYVAZ_TY            = 212       # output frames
REYVAZ_CLASS_NAMES   = ["glassbreak", "gunshot"]
REYVAZ_FRAME_DUR_S   = REYVAZ_TRACK_DURATION / REYVAZ_TY
REYVAZ_DEFAULT_THRESH = 0.3

# ── Bayesian fusion constants ────────────────────────────────────────────────
REYVAZ_PRIOR              = 0.02
REYVAZ_LIKELIHOOD         = 0.90
REYVAZ_FALSE_POSITIVE_RATE = 0.05
REYVAZ_SLIDING_WINDOW     = 10
REYVAZ_POSTERIOR_ALERT     = 0.70


# ── Pydantic schemas for the Reyvaz endpoint ────────────────────────────────
class ReyvazRequest(BaseModel):
    audio_b64: str
    threshold: Optional[float] = None  # override default 0.3

class DetectionItem(BaseModel):
    class_name: str
    class_index: int
    onset_frame: int
    onset_time_s: float
    max_confidence: float

class ReyvazResponse(BaseModel):
    triggered: bool
    label: Optional[str] = None
    glass_score: float = 0.0
    gunshot_score: float = 0.0
    glass_posterior: float = 0.0
    gunshot_posterior: float = 0.0
    detections: List[DetectionItem] = []
    process_time_ms: float = 0.0
    error: Optional[str] = None


@app.cls(image=reyvaz_image, gpu="a10g", volumes={REYVAZ_MODEL_DIR: reyvaz_volume}, timeout=120, keep_warm=1)
class ReyvazDetector:
    """
    LSTM/GRU acoustic threat detector for glassbreak and gunshot events.
    Runs on CPU — model is only ~33 MB.
    """

    @modal.enter()
    def load_model(self):
        import os
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        os.environ["TF_USE_LEGACY_KERAS"] = "1"
        import tensorflow as tf
        tf.get_logger().setLevel("ERROR")

        model_path = os.path.join(REYVAZ_MODEL_DIR, REYVAZ_MODEL_FILE)
        if not os.path.isfile(model_path):
            raise FileNotFoundError(
                f"Model not found at {model_path}. "
                "Run `modal run modal_api.py::upload_reyvaz_model` first."
            )

        try:
            import tf_keras
            self.model = tf_keras.models.load_model(model_path, compile=False)
        except ImportError:
            self.model = tf.keras.models.load_model(model_path, compile=False)

        print("Reyvaz model loaded.")

    # ── Feature extraction (replicates sed2_utils.py exactly) ────────────
    @staticmethod
    def _extract_features(audio_data, sr=REYVAZ_SAMPLE_RATE):
        import numpy as np
        import librosa

        audio_data = audio_data.astype(np.float32)
        S = librosa.feature.melspectrogram(y=audio_data, sr=sr)
        lmf = librosa.power_to_db(S ** REYVAZ_MEL_POWER, ref=np.max)
        features = lmf.T  # (time, 128)

        if features.shape[0] < REYVAZ_TX:
            features = np.pad(features, ((0, REYVAZ_TX - features.shape[0]), (0, 0)))
        elif features.shape[0] > REYVAZ_TX:
            features = features[:REYVAZ_TX, :]

        return features

    # ── Inference ────────────────────────────────────────────────────────
    @staticmethod
    def _run_inference(model, features, threshold):
        import numpy as np

        x = features[np.newaxis, :, :]
        preds = model.predict(x, verbose=0)[0]  # (TY, 2)

        detections = []
        for cls_idx, cls_name in enumerate(REYVAZ_CLASS_NAMES):
            cls_preds = preds[:, cls_idx]
            max_conf = float(np.max(cls_preds))
            above = np.where(cls_preds >= threshold)[0]

            if len(above) > 0:
                onset_frame = int(above[0])
                detections.append(DetectionItem(
                    class_name=cls_name,
                    class_index=cls_idx,
                    onset_frame=onset_frame,
                    onset_time_s=round(onset_frame * REYVAZ_FRAME_DUR_S, 2),
                    max_confidence=round(max_conf, 4),
                ))

        return preds, detections

    # ── Bayesian update (stateless per-request) ──────────────────────────
    @staticmethod
    def _bayesian_update(confidence: float, prior: float = REYVAZ_PRIOR) -> float:
        scaled_likelihood = REYVAZ_LIKELIHOOD * confidence
        scaled_fp = (
            REYVAZ_FALSE_POSITIVE_RATE * (1 - confidence)
            + REYVAZ_FALSE_POSITIVE_RATE * confidence
        )
        numerator = scaled_likelihood * prior
        denominator = numerator + scaled_fp * (1 - prior)
        return numerator / denominator if denominator > 0 else prior

    # ── FastAPI endpoint ─────────────────────────────────────────────────
    @modal.fastapi_endpoint(method="POST", docs=True)
    def detect(self, req: ReyvazRequest) -> ReyvazResponse:
        import base64
        import tempfile
        import os
        import time
        import traceback
        import numpy as np
        import librosa

        try:
            start = time.perf_counter()
            threshold = req.threshold if req.threshold is not None else REYVAZ_DEFAULT_THRESH

            # Decode audio
            audio_bytes = base64.b64decode(req.audio_b64)

            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name

            try:
                audio_array, sr = librosa.load(tmp_path, sr=REYVAZ_SAMPLE_RATE, mono=True)
            finally:
                os.remove(tmp_path)

            # Process in chunks of TRACK_DURATION (10s)
            chunk_samples = int(REYVAZ_SAMPLE_RATE * REYVAZ_TRACK_DURATION)
            total_chunks = max(1, len(audio_array) // chunk_samples)

            all_detections = []
            best_glass = 0.0
            best_gunshot = 0.0

            for i in range(total_chunks):
                chunk = audio_array[i * chunk_samples : (i + 1) * chunk_samples]
                if len(chunk) < chunk_samples:
                    chunk = np.pad(chunk, (0, chunk_samples - len(chunk)))

                features = self._extract_features(chunk, sr=REYVAZ_SAMPLE_RATE)
                preds, detections = self._run_inference(self.model, features, threshold)

                glass_score = float(np.max(preds[:, 0]))
                gunshot_score = float(np.max(preds[:, 1]))
                best_glass = max(best_glass, glass_score)
                best_gunshot = max(best_gunshot, gunshot_score)

                all_detections.extend(detections)

            # Compute posteriors from best scores
            glass_posterior = self._bayesian_update(best_glass) if best_glass > 0.05 else REYVAZ_PRIOR
            gunshot_posterior = self._bayesian_update(best_gunshot) if best_gunshot > 0.05 else REYVAZ_PRIOR

            triggered = len(all_detections) > 0
            label = None
            if triggered:
                label = "gunshot" if best_gunshot > best_glass else "glassbreak"

            elapsed_ms = (time.perf_counter() - start) * 1000

            return ReyvazResponse(
                triggered=triggered,
                label=label,
                glass_score=round(best_glass, 4),
                gunshot_score=round(best_gunshot, 4),
                glass_posterior=round(glass_posterior, 4),
                gunshot_posterior=round(gunshot_posterior, 4),
                detections=all_detections,
                process_time_ms=round(elapsed_ms, 1),
            )

        except Exception as e:
            traceback.print_exc()
            return ReyvazResponse(triggered=False, error=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# ENDPOINT 2 — Qwen2-Audio Deep Analysis (A100 GPU)
# ═══════════════════════════════════════════════════════════════════════════════

# ── Image ────────────────────────────────────────────────────────────────────
qwen2_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.4.0",
        "transformers>=4.45.0",
        "accelerate>=0.34.2",
        "librosa==0.10.2.post1",
        "soundfile==0.12.1",
        "fastapi[standard]",
        "pydantic",
    )
)

# ── Volume for Qwen2 model weights ──────────────────────────────────────────
qwen2_volume = modal.Volume.from_name("qwen2-audio-7b-weights", create_if_missing=True)
QWEN2_MODEL_DIR = "/model_cache"
QWEN2_MODEL_ID  = "Qwen/Qwen2-Audio-7B-Instruct"

# ── Helper: pre-download Qwen2 weights ──────────────────────────────────────
@app.function(image=qwen2_image, volumes={QWEN2_MODEL_DIR: qwen2_volume}, timeout=3600)
def download_model():
    from transformers import Qwen2AudioForConditionalGeneration, AutoProcessor
    import torch
    print(f"Downloading model {QWEN2_MODEL_ID} to volume {QWEN2_MODEL_DIR}...")
    AutoProcessor.from_pretrained(QWEN2_MODEL_ID, cache_dir=QWEN2_MODEL_DIR)
    Qwen2AudioForConditionalGeneration.from_pretrained(
        QWEN2_MODEL_ID, device_map="auto", torch_dtype=torch.float16, cache_dir=QWEN2_MODEL_DIR
    )
    print("Done downloading.")
    qwen2_volume.commit()


# ── Pydantic schemas for the Qwen2 endpoint ─────────────────────────────────
class Qwen2Request(BaseModel):
    audio_b64: str
    label: str
    posterior: float
    scores: Dict[str, float] = {}

class Qwen2Response(BaseModel):
    text: str
    error: Optional[str] = None


@app.cls(image=qwen2_image, gpu="a100", volumes={QWEN2_MODEL_DIR: qwen2_volume}, timeout=300, keep_warm=1)
class Qwen2AudioModel:
    """
    Qwen2-Audio-7B-Instruct for deep audio reasoning.
    Runs on an A100 GPU.
    """

    @modal.enter()
    def load_model(self):
        import torch
        from transformers import Qwen2AudioForConditionalGeneration, AutoProcessor
        print("Loading Qwen2-Audio model...")
        self.processor = AutoProcessor.from_pretrained(QWEN2_MODEL_ID, cache_dir=QWEN2_MODEL_DIR)
        self.model = Qwen2AudioForConditionalGeneration.from_pretrained(
            QWEN2_MODEL_ID,
            device_map="auto",
            torch_dtype=torch.float16,
            cache_dir=QWEN2_MODEL_DIR,
        )
        self.model.eval()
        print("Qwen2-Audio model loaded successfully.")

    @modal.fastapi_endpoint(method="POST", docs=True)
    def analyze(self, req: Qwen2Request) -> Qwen2Response:
        import base64
        import torch
        import librosa
        import traceback
        import tempfile
        import os

        try:
            audio_bytes = base64.b64decode(req.audio_b64)

            prompt_text = (
                f"An automated acoustic threat detection system flagged this audio clip "
                f"based on the Reyvaz acoustic model.\n"
                f"Detection results:\n"
                f"- Classified as: {req.label}\n"
                f"- Posterior confidence: {req.posterior:.0%}\n"
                f"- Reyvaz model scores — glass: {req.scores.get('reyvaz_glass', 0.0):.2f}, "
                f"gunshot: {req.scores.get('reyvaz_gunshot', 0.0):.2f}\n\n"
                f"Listen to the audio and answer concisely:\n"
                f"1. Do you agree with the classification ({req.label})? What do you hear?\n"
                f"2. If this is a gunshot, how many shots were fired, and what is the likely weapon type? (If not a gunshot, say N/A)\n"
                f"3. If this is breaking glass, what type of glass might it be (e.g., window, bottle), and what could have caused it? (If not glass, say N/A)\n"
                f"4. Is this likely a real threat or a false positive? Why?\n"
                f"5. What should a school security officer do right now?"
            )

            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_audio:
                temp_audio.write(audio_bytes)
                temp_audio_path = temp_audio.name

            try:
                audio_array, sr = librosa.load(
                    temp_audio_path,
                    sr=self.processor.feature_extractor.sampling_rate,
                )
            finally:
                os.remove(temp_audio_path)

            conversation = [
                {"role": "system", "content": "You are a helpful AI assistant specialized in analyzing audio."},
                {"role": "user", "content": [
                    {"type": "audio", "audio_url": "audio_placeholder"},
                    {"type": "text", "text": prompt_text},
                ]},
            ]

            text_input = self.processor.apply_chat_template(
                conversation, add_generation_prompt=True, tokenize=False
            )

            inputs = self.processor(
                text=text_input,
                audios=[audio_array],
                return_tensors="pt",
                padding=True,
            ).to(self.model.device, dtype=torch.float16)

            with torch.no_grad():
                generated_ids = self.model.generate(**inputs, max_new_tokens=400)

            generated_ids = generated_ids[:, inputs.input_ids.size(1):]

            response_text = self.processor.batch_decode(
                generated_ids,
                skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            )[0]

            return Qwen2Response(text=response_text.strip())

        except Exception as e:
            traceback.print_exc()
            return Qwen2Response(text="", error=str(e))
