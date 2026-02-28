import os
import requests
import base64
import cv2
import numpy as np
import json
import time

# Modal API Endpoint
FAST_VISION_URL = "https://apat7--akawa-vlm-api-fastvisionapi-analyze.modal.run"

# Local Video Paths (from the project's native dataset)
VIOLENCE_VIDEO_PATH = "/Users/aooman/Documents/code/purdue/hackillinois/test/vision/real-life-violence-situations-dataset/Real Life Violence Dataset/Violence/V_1.mp4"
NON_VIOLENCE_VIDEO_PATH = "/Users/aooman/Documents/code/purdue/hackillinois/test/vision/real-life-violence-situations-dataset/Real Life Violence Dataset/NonViolence/NV_1.mp4"

def get_frames(video_path, max_frames=20):
    if not os.path.exists(video_path):
        print(f"[ERROR] Video file NOT found: {video_path}")
        return []
    
    cap = cv2.VideoCapture(video_path)
    frames = []
    while len(frames) < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        # FastVisionAPI (TwoStream) expects 84x84 sequence internally, 
        # but we send original and it handles resize.
        # We'll send a small resize for bandwidth efficiency in testing.
        compressed = cv2.resize(frame, (224, 224))
        frames.append(compressed)
    cap.release()
    print(f"[INFO] Extracted {len(frames)} frames from {video_path}")
    return frames

def encode_frames(frames):
    encoded = []
    for f in frames:
        _, buffer = cv2.imencode('.jpg', f, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
        encoded.append(base64.b64encode(buffer).decode('utf-8'))
    return encoded

def test_endpoint(video_path, label):
    print(f"\n{'='*20} TESTING {label} {'='*20}")
    print(f"[FILE] {video_path}")
    
    # 1. Test Frame Sequence (TwoStream)
    frames = get_frames(video_path, max_frames=20)
    if not frames:
        print(f"[SKIP] No frames extracted for {label}")
        return

    encoded_sequence = encode_frames(frames)
    payload = {
        "frame_sequence_b64": encoded_sequence,
        "video_name": f"test_{label.lower()}"
    }

    print(f"[REQUEST] Sending batch of 20 frames to {FAST_VISION_URL}...")
    start_time = time.time()
    try:
        resp = requests.post(FAST_VISION_URL, json=payload, timeout=60)
        duration = time.time() - start_time
        print(f"[RESPONSE] Status: {resp.status_code} | Time: {duration:.2f}s")
        
        if resp.status_code == 200:
            data = resp.json()
            print("[DATA] Full response:")
            print(json.dumps(data, indent=2))
        else:
            print(f"[ERROR] {resp.text}")
    except Exception as e:
        print(f"[ERROR] API Request failed: {e}")

    # 2. Test Full Video (YOLO + TwoStream)
    if os.path.getsize(video_path) > 10 * 1024 * 1024:
        print(f"[SKIP] Video too large ({os.path.getsize(video_path)/1024/1024:.1f}MB) for direct B64 payload test.")
        return

    print(f"\n[REQUEST] Sending full video file as B64...")
    with open(video_path, "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode('utf-8')
    
    payload_full = {
        "video_b64": video_b64,
        "video_name": f"full_test_{label.lower()}"
    }
    
    start_time = time.time()
    try:
        resp = requests.post(FAST_VISION_URL, json=payload_full, timeout=120)
        duration = time.time() - start_time
        print(f"[RESPONSE] Status: {resp.status_code} | Time: {duration:.2f}s")
        
        if resp.status_code == 200:
            data = resp.json()
            print("[DATA] Full video analysis response:")
            print(json.dumps(data, indent=2))
        else:
            print(f"[ERROR] {resp.text}")
    except Exception as e:
        print(f"[ERROR] API Request failed: {e}")

if __name__ == "__main__":
    test_endpoint(VIOLENCE_VIDEO_PATH, "VIOLENCE")
    test_endpoint(NON_VIOLENCE_VIDEO_PATH, "NON-VIOLENCE")
