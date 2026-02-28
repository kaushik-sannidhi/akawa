"""
YOLO Training Script - Train Weapons (alternate config)
Fine-tunes yolo11m.pt on the Master_Weapon_Dataset.
Usage: python train_weapons.py
"""

from ultralytics import YOLO
from pathlib import Path
import os

def main():
    # Resolve paths relative to project root
    project_root = Path(__file__).resolve().parent.parent
    data_yaml_path = project_root / "Master_Weapon_Dataset" / "Master_Weapon_Dataset" / "data.yaml"
    base_model = Path(__file__).resolve().parent / "yolo11m.pt"

    if not data_yaml_path.exists():
        print(f"Error: {data_yaml_path} does not exist!")
        return

    print("Initializing YOLO11m model...")
    model = YOLO(str(base_model))

    print(f"Starting training using data from {data_yaml_path}...")
    results = model.train(
        data=str(data_yaml_path),
        epochs=150,
        imgsz=640,
        cache=True,
        workers=4,
        patience=10,
        project=str(project_root / "runs" / "detect"),
        name="train_weapons_sanity",
        exist_ok=True,
    )

    print("\nTraining complete.")
    print(f"Best weights saved at: {model.ckpt_path}")

    metrics = results.results_dict
    if metrics:
        map50 = metrics.get("metrics/mAP50(B)")
        map50_95 = metrics.get("metrics/mAP50-95(B)")
        print(f"\nFinal Validation Metrics:")
        print(f"mAP50: {map50:.4f}")
        print(f"mAP50-95: {map50_95:.4f}")

    print("\n[Optional] To run inference with BoT-SORT tracking on a video, use:")
    print(f"tracked_results = model.track(source='path/to/video.mp4', tracker='botsort.yaml', show=True)")
    
if __name__ == "__main__":
    main()
