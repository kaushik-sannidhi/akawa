"""
YOLO Training Script for Weapon Detection
Fine-tunes yolo11m.pt on the Master_Weapon_Dataset.
Usage: python train_yolo.py
"""

from ultralytics import YOLO
import os

def main():
    # Resolve paths relative to project root
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    data_yaml = os.path.join(project_root, "Master_Weapon_Dataset", "Master_Weapon_Dataset", "data.yaml")
    base_model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yolo11m.pt")

    if not os.path.exists(data_yaml):
        raise FileNotFoundError(f"Dataset config not found at {data_yaml}")
    if not os.path.exists(base_model):
        raise FileNotFoundError(f"Base model not found at {base_model}")

    print(f"=== YOLO Weapon Detection Training ===")
    print(f"Base model : {base_model}")
    print(f"Dataset    : {data_yaml}")
    print()

    model = YOLO(base_model)

    model.train(
        data=data_yaml,
        epochs=150,
        imgsz=640,
        batch=16,
        cache=True,
        workers=4,
        patience=10,
        project=os.path.join(project_root, "runs", "detect"),
        name="weapon_detector",
        exist_ok=True,
        verbose=True,
    )

    # After training, the best model is at runs/detect/weapon_detector/weights/best.pt
    best_path = os.path.join(project_root, "runs", "detect", "weapon_detector", "weights", "best.pt")
    if os.path.exists(best_path):
        print(f"\n✓ Training complete! Best model saved to: {best_path}")
    else:
        print(f"\n⚠ Training finished but best.pt not found at expected path.")

if __name__ == "__main__":
    main()
