import cv2
import numpy as np
import time
import os

try:
    import tensorflow as tf
    from keras.models import load_model
except ImportError:
    print("TensorFlow not installed. Fight detection won't load.")

class FightDetector:
    def __init__(self, model_path=None):
        if model_path is None:
            # Point to the root directory where keras_model.h5 is located
            model_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "keras_model.h5")
            
        self.model_type = "fight"
        
        try:
            # Ensure TensorFlow uses GPU memory growth to prevent allocating all GPU memory
            physical_devices = tf.config.list_physical_devices('GPU')
            if physical_devices:
                try:
                    for device in physical_devices:
                        tf.config.experimental.set_memory_growth(device, True)
                except Exception:
                    pass
        except Exception:
            pass
            
        print(f"Loading Fight Detection Model from {model_path}")
        
        if os.path.exists(model_path):
            try:
                self.model = load_model(model_path, compile=False)
                print("Successfully loaded Fight Detection model.")
            except Exception as e:
                print(f"Failed to load model: {e}")
                self.model = None
        else:
            print(f"Model path {model_path} does not exist.")
            self.model = None

        self.frames_buffer = []  # To store the last 64 resized RGB frames
        self.flows_buffer = []   # To store the last 64 optical flows
        self.prev_gray = None
        self.last_infer_time = 0
        self.last_detections = []

    def normalize(self, data):
        mean = np.mean(data)
        std = np.std(data)
        if std == 0:
            std = 1
        return (data - mean) / std

    def process_frame(self, frame):
        detections = []
        
        if self.model is None:
            return detections

        # Real-time computation of optical flow
        resized_frame = cv2.resize(frame, (224, 224), interpolation=cv2.INTER_AREA)
        rgb_frame = cv2.cvtColor(resized_frame, cv2.COLOR_BGR2RGB)
        gray_frame = cv2.cvtColor(resized_frame, cv2.COLOR_BGR2GRAY)
        
        if self.prev_gray is None:
            flow = np.zeros((224, 224, 2), dtype=np.float32)
        else:
            flow = cv2.calcOpticalFlowFarneback(self.prev_gray, gray_frame, None, 0.5, 3, 15, 3, 5, 1.2, cv2.OPTFLOW_FARNEBACK_GAUSSIAN)
            # Subtract mean
            flow[..., 0] -= np.mean(flow[..., 0])
            flow[..., 1] -= np.mean(flow[..., 1])
            # Normalize each component
            flow[..., 0] = cv2.normalize(flow[..., 0], None, 0, 255, cv2.NORM_MINMAX)
            flow[..., 1] = cv2.normalize(flow[..., 1], None, 0, 255, cv2.NORM_MINMAX)

        self.prev_gray = gray_frame

        self.frames_buffer.append(rgb_frame)
        self.flows_buffer.append(flow)
        
        # Maintain buffer of 64 frames
        if len(self.frames_buffer) > 64:
            self.frames_buffer.pop(0)
            self.flows_buffer.pop(0)
            
        # We need exactly 64 frames to predict
        if len(self.frames_buffer) < 64:
            return detections
            
        current_time = time.time()
        # Throttle inference to e.g., once every 0.1s to save GPU compute but keep action smooth
        if current_time - self.last_infer_time < 0.1:
            return getattr(self, "last_detections", [])
            
        self.last_infer_time = current_time
            
        clip_frames = np.array(self.frames_buffer, dtype=np.float32)
        clip_flows = np.array(self.flows_buffer, dtype=np.float32)
        
        clip_frames_norm = self.normalize(clip_frames)
        clip_flows_norm = self.normalize(clip_flows)
        
        input_data = np.zeros((1, 64, 224, 224, 5), dtype=np.float32)
        input_data[0, ..., :3] = clip_frames_norm
        input_data[0, ..., 3:] = clip_flows_norm
        
        try:
            preds = self.model.predict(input_data, verbose=0)
            
            # The DataGenerator had classes ['Fight', 'NonFight'] typically (alphabetically sorted).
            # So class 0 is Fight, class 1 is NonFight.
            # Assuming output is shape (1, 2).
            fight_prob = float(preds[0][0])
            
            if fight_prob > 0.50:
                # Output a full-frame bounding box for the action "fight"
                detections.append({
                    "id": f"fight_{int(current_time * 1000)}",
                    "class_id": 999,
                    "class_name": "fight",
                    "confidence": float(round(fight_prob, 3)),
                    "bbox": {
                        "x1": 0.05,
                        "y1": 0.05,
                        "x2": 0.95,
                        "y2": 0.95
                    }
                })
        except Exception as e:
            print(f"Fight inference error: {e}")
            
        self.last_detections = detections
        return detections
