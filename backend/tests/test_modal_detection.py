import cv2
import base64
import requests
import os
import json

# Configuration
MODAL_ENDPOINT = "https://apat7--akawa-vlm-api-fastvisionapi-analyze.modal.run"
VIDEO_PATH = "/Users/aooman/Documents/code/purdue/hackillinois/test/vision/real-life-violence-situations-dataset/Real Life Violence Dataset/Violence/V_1.mp4"
SEQUENCE_LENGTH = 20

def test_modal_detection():
    if not os.path.exists(VIDEO_PATH):
        print(f"Error: Video file not found at {VIDEO_PATH}")
        return

    print(f"Opening video: {VIDEO_PATH}")
    cap = cv2.VideoCapture(VIDEO_PATH)
    
    frames = []
    count = 0
    while len(frames) < SEQUENCE_LENGTH:
        ret, frame = cap.read()
        if not ret:
            print("End of video reached early.")
            break
        
        # Resize to match backend expectations or just encode high quality
        # Backend uses 84x84 for brawl but original frames for weapon/pose
        # We'll send standard frames encoded as JPG
        ret, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if ret:
            b64_frame = base64.b64encode(buf).decode("utf-8")
            frames.append(b64_frame)
        
        count += 1
    
    cap.release()
    print(f"Captured {len(frames)} frames.")

    if not frames:
        print("No frames captured.")
        return

    payload = {
        "frame_sequence_b64": frames,
        "video_name": "test_V_1",
        "source_type": "upload",
        "stream_id": "test_stream"
    }

    print(f"Sending request to {MODAL_ENDPOINT}...")
    try:
        response = requests.post(MODAL_ENDPOINT, json=payload, timeout=30)
        
        if response.status_code == 200:
            print("Response received successfully!")
            result = response.json()
            
            # Print high-level results
            print("\n--- Summary ---")
            print(f"Threat Type: {result.get('threat_type')}")
            print(f"Weapons Detected: {result.get('weapons_detected')}")
            print(f"Weapon Confidence: {result.get('weapon_confidence', 0):.2f}")
            print(f"Violence Detected: {result.get('violence_detected')}")
            print(f"Violence Confidence: {result.get('violence_confidence', 0):.2f}")
            print(f"Fall Detected: {result.get('fall_detected')}")
            print(f"Fall Confidence: {result.get('fall_confidence', 0):.2f}")
            
            # Print Detections Summary
            detections = result.get("detections", [])
            print(f"\nTotal Detections: {len(detections)}")
            
            # Group by type
            types = {}
            for d in detections:
                dtype = d.get("detection_type")
                types[dtype] = types.get(dtype, 0) + 1
            
            for dtype, count in types.items():
                print(f" - {dtype}: {count}")

            # Print first few bounding boxes for verification
            if detections:
                print("\nSample Bounding Boxes (normalized):")
                for d in detections[:5]:
                    print(f" - {d.get('class_name')} ({d.get('detection_type')}): {d.get('bbox')}")
            
            # Per-frame detections check
            per_frame = result.get("per_frame_detections") or {}
            print(f"\nFrames with detections: {list(per_frame.keys())}")

        else:
            print(f"Error: {response.status_code}")
            print(response.text)
            
    except Exception as e:
        print(f"Request failed: {e}")

if __name__ == "__main__":
    test_modal_detection()
