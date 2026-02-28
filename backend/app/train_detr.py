"""
DETR Training Script for Weapon Detection
Fine-tunes facebook/detr-resnet-50 on the Master_Weapon_Dataset.

The Master_Weapon_Dataset uses YOLO format (txt labels), so this script
converts them to COCO format on-the-fly for DETR training.

Usage:
    pip install transformers timm torch torchvision Pillow
    python train_detr.py

Output:
    runs/detect/detr_weapon_detector/weights/best.pt
"""

import os
import json
import torch
import numpy as np
from pathlib import Path
from PIL import Image
from torch.utils.data import Dataset, DataLoader
from transformers import DetrForObjectDetection, DetrImageProcessor
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR
import time

# ==================== Config ====================

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = PROJECT_ROOT / "Master_Weapon_Dataset" / "Master_Weapon_Dataset"
OUTPUT_DIR = PROJECT_ROOT / "runs" / "detect" / "detr_weapon_detector"
WEIGHTS_DIR = OUTPUT_DIR / "weights"

NUM_CLASSES = 4  # person, weapon, bagofchips, umbrella
CLASS_NAMES = {0: "person", 1: "weapon", 2: "bagofchips", 3: "umbrella"}
MODEL_NAME = "facebook/detr-resnet-50"

EPOCHS = 50
BATCH_SIZE = 4
LR = 1e-5
PATIENCE = 10
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# ==================== YOLO-to-COCO Dataset ====================

class YoloToCOCODataset(Dataset):
    """
    Reads YOLO-format labels (class x_center y_center w h) and converts
    them to the format expected by DETR (COCO-style pixel bounding boxes).
    """

    def __init__(self, images_dir, labels_dir, processor):
        self.processor = processor
        self.images_dir = Path(images_dir)
        self.labels_dir = Path(labels_dir)

        # Find all images that have corresponding label files
        self.image_files = []
        for ext in ["*.jpg", "*.jpeg", "*.png", "*.bmp"]:
            for img_path in self.images_dir.glob(ext):
                label_path = self.labels_dir / (img_path.stem + ".txt")
                if label_path.exists():
                    self.image_files.append((img_path, label_path))

        print(f"  Found {len(self.image_files)} images with labels in {images_dir}")

    def __len__(self):
        return len(self.image_files)

    def __getitem__(self, idx):
        img_path, label_path = self.image_files[idx]

        # Load image
        image = Image.open(img_path).convert("RGB")
        w, h = image.size

        # Parse YOLO labels → COCO format
        boxes = []
        class_labels = []

        with open(label_path, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 5:
                    continue
                cls_id = int(parts[0])
                x_center = float(parts[1]) * w
                y_center = float(parts[2]) * h
                box_w = float(parts[3]) * w
                box_h = float(parts[4]) * h

                # Convert to [x_min, y_min, x_max, y_max]
                x_min = x_center - box_w / 2
                y_min = y_center - box_h / 2
                x_max = x_center + box_w / 2
                y_max = y_center + box_h / 2

                # Clamp to image bounds
                x_min = max(0, x_min)
                y_min = max(0, y_min)
                x_max = min(w, x_max)
                y_max = min(h, y_max)

                if x_max > x_min and y_max > y_min:
                    # DETR/COCO format: [x_min, y_min, width, height]
                    boxes.append([x_min, y_min, x_max - x_min, y_max - y_min])
                    class_labels.append(cls_id)

        # Build annotations dict
        annotations = {
            "image_id": idx,
            "annotations": [
                {
                    "bbox": box,
                    "category_id": cls,
                    "area": box[2] * box[3],
                    "iscrowd": 0,
                }
                for box, cls in zip(boxes, class_labels)
            ],
        }

        # Resize image to fixed size for uniform batching
        image = image.resize((800, 800), Image.BILINEAR)

        # Rescale boxes to new size
        scale_x = 800 / w
        scale_y = 800 / h
        for ann in annotations["annotations"]:
            bx, by, bw, bh = ann["bbox"]
            ann["bbox"] = [bx * scale_x, by * scale_y, bw * scale_x, bh * scale_y]
            ann["area"] = ann["bbox"][2] * ann["bbox"][3]

        # Process with DETR processor
        encoding = self.processor(
            images=image,
            annotations=[annotations],
            return_tensors="pt",
            do_resize=False,  # Already resized
        )

        # Remove batch dimension
        pixel_values = encoding["pixel_values"].squeeze(0)
        target = encoding["labels"][0]

        return pixel_values, target


def collate_fn(batch):
    pixel_values = [item[0] for item in batch]
    labels = [item[1] for item in batch]

    # Pad to max size in batch (all should be 800x800 but just in case)
    max_h = max(pv.shape[1] for pv in pixel_values)
    max_w = max(pv.shape[2] for pv in pixel_values)
    padded = []
    for pv in pixel_values:
        pad_h = max_h - pv.shape[1]
        pad_w = max_w - pv.shape[2]
        if pad_h > 0 or pad_w > 0:
            pv = torch.nn.functional.pad(pv, (0, pad_w, 0, pad_h))
        padded.append(pv)

    return {"pixel_values": torch.stack(padded), "labels": labels}


# ==================== Training ====================

def train():
    os.makedirs(WEIGHTS_DIR, exist_ok=True)

    print(f"=== DETR Weapon Detection Training ===")
    print(f"Model      : {MODEL_NAME}")
    print(f"Dataset    : {DATA_ROOT}")
    print(f"Classes    : {CLASS_NAMES}")
    print(f"Device     : {DEVICE}")
    print(f"Epochs     : {EPOCHS}")
    print(f"Batch Size : {BATCH_SIZE}")
    print(f"Patience   : {PATIENCE}")
    print()

    # Load DETR processor and model
    print("[1/4] Loading DETR model and processor...")
    processor = DetrImageProcessor.from_pretrained(MODEL_NAME)
    model = DetrForObjectDetection.from_pretrained(
        MODEL_NAME,
        num_labels=NUM_CLASSES,
        ignore_mismatched_sizes=True,  # Because class head changes
    )
    model.to(DEVICE)

    # Build datasets
    print("[2/4] Preparing datasets...")
    train_images = DATA_ROOT / "images" / "train"
    train_labels = DATA_ROOT / "labels" / "train"
    val_images = DATA_ROOT / "images" / "val"
    val_labels = DATA_ROOT / "labels" / "val"

    train_dataset = YoloToCOCODataset(train_images, train_labels, processor)
    val_dataset = YoloToCOCODataset(val_images, val_labels, processor)

    train_loader = DataLoader(
        train_dataset,
        batch_size=BATCH_SIZE,
        shuffle=True,
        collate_fn=collate_fn,
        num_workers=4,
        pin_memory=True,
    )
    val_loader = DataLoader(
        val_dataset,
        batch_size=BATCH_SIZE,
        shuffle=False,
        collate_fn=collate_fn,
        num_workers=4,
        pin_memory=True,
    )

    # Optimizer and scheduler
    optimizer = AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = CosineAnnealingLR(optimizer, T_max=EPOCHS)

    # Training loop
    print(f"[3/4] Training for {EPOCHS} epochs (patience={PATIENCE})...")
    print()

    best_val_loss = float("inf")
    patience_counter = 0
    train_losses = []
    val_losses = []

    for epoch in range(1, EPOCHS + 1):
        # === Train ===
        model.train()
        epoch_loss = 0
        start_time = time.time()

        for batch_idx, batch in enumerate(train_loader):
            pixel_values = batch["pixel_values"].to(DEVICE)
            labels = [{k: v.to(DEVICE) for k, v in t.items()} for t in batch["labels"]]

            outputs = model(pixel_values=pixel_values, labels=labels)
            loss = outputs.loss

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=0.1)
            optimizer.step()

            epoch_loss += loss.item()

        scheduler.step()
        avg_train_loss = epoch_loss / len(train_loader)
        train_losses.append(avg_train_loss)

        # === Validate ===
        model.eval()
        val_loss = 0
        with torch.no_grad():
            for batch in val_loader:
                pixel_values = batch["pixel_values"].to(DEVICE)
                labels = [{k: v.to(DEVICE) for k, v in t.items()} for t in batch["labels"]]

                outputs = model(pixel_values=pixel_values, labels=labels)
                val_loss += outputs.loss.item()

        avg_val_loss = val_loss / max(len(val_loader), 1)
        val_losses.append(avg_val_loss)
        elapsed = time.time() - start_time

        # === Logging ===
        gpu_mem = ""
        if torch.cuda.is_available():
            gpu_mem = f" | GPU: {torch.cuda.memory_allocated() / 1e9:.2f}GB"
        print(
            f"  Epoch {epoch:3d}/{EPOCHS} | "
            f"Train Loss: {avg_train_loss:.4f} | "
            f"Val Loss: {avg_val_loss:.4f} | "
            f"Time: {elapsed:.1f}s{gpu_mem}"
        )

        # === Early stopping ===
        if avg_val_loss < best_val_loss:
            best_val_loss = avg_val_loss
            patience_counter = 0
            # Save best model
            torch.save(model.state_dict(), WEIGHTS_DIR / "best.pt")
            processor.save_pretrained(WEIGHTS_DIR)
            # Save config for loading later
            config_data = {
                "model_name": MODEL_NAME,
                "num_classes": NUM_CLASSES,
                "class_names": CLASS_NAMES,
                "best_val_loss": best_val_loss,
                "best_epoch": epoch,
            }
            with open(WEIGHTS_DIR / "config.json", "w") as f:
                json.dump(config_data, f, indent=2)
            print(f"         ↳ Saved new best model (val_loss={best_val_loss:.4f})")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                print(f"\n  Early stopping at epoch {epoch} (no improvement for {PATIENCE} epochs)")
                break

    # Save last model
    torch.save(model.state_dict(), WEIGHTS_DIR / "last.pt")
    print(f"\n[4/4] Training complete!")
    print(f"  Best val loss : {best_val_loss:.4f}")
    print(f"  Best model    : {WEIGHTS_DIR / 'best.pt'}")
    print(f"  Last model    : {WEIGHTS_DIR / 'last.pt'}")


if __name__ == "__main__":
    train()
