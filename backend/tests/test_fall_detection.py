import cv2
import numpy as np
import sys
import os

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from vision.fall_detection import FallDetector

def test_fall_detector():
    print("Testing FallDetector initialization...")
    try:
        detector = FallDetector()
        print("✓ FallDetector initialized successfully")
    except Exception as e:
        print(f"✗ FallDetector initialization failed: {e}")
        return

    print("\nTesting detection on a blank frame...")
    blank_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    try:
        detections = detector.detect(blank_frame)
        print(f"✓ Detection ran successfully. Found {len(detections)} falls (expected 0 on blank frame).")
        print(f"Detections: {detections}")
    except Exception as e:
        print(f"✗ Detection failed: {e}")

if __name__ == "__main__":
    test_fall_detector()
