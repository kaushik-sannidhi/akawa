"""
Report service for Akawa incident reporting.
Handles:
1) VLM summary enrichment
2) PDF report generation
3) Cloudflare R2 upload
4) Firebase persistence
5) Optional report-generated email notification
"""
from __future__ import annotations


import base64
import logging
import os
import shutil
import subprocess
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com"
REPORTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)

VLM_ANALYZE_URL = os.getenv(
    "VLM_ANALYZE_URL",
    "https://apat7--akawa-vlm-api-qwen2vlmodel-analyze.modal.run",
)
VLM_REPORT_PROMPT = os.getenv(
    "VLM_REPORT_PROMPT",
    (
        "You are writing a formal security incident report. "
        "Summarize the event in clear operational language, include observed behavior, "
        "risk level, and immediate recommended actions. Keep it concise."
    ),
)

REQUIRE_R2_REPORT_UPLOADS = os.getenv("REQUIRE_R2_REPORT_UPLOADS", "true").strip().lower() not in (
    "0",
    "false",
    "no",
)
ALLOW_LOCAL_REPORT_FALLBACK = os.getenv("ALLOW_LOCAL_REPORT_FALLBACK", "true").strip().lower() in (
    "1",
    "true",
    "yes",
)


def _read_file_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _local_asset_url(uid: str, report_id: str, filename: str) -> str:
    return f"/reports/{uid}/{report_id}/{filename}"


def _write_local_asset(uid: str, report_id: str, filename: str, data: bytes) -> str:
    report_dir = os.path.join(REPORTS_DIR, uid, report_id)
    os.makedirs(report_dir, exist_ok=True)
    out_path = os.path.join(report_dir, filename)
    with open(out_path, "wb") as f:
        f.write(data)
    return _local_asset_url(uid, report_id, filename)


def _transcode_to_mp4(input_path: str, output_path: str) -> bool:
    """
    Convert clips to browser-friendly MP4 when ffmpeg is available.
    Falls back to original bytes if ffmpeg is unavailable/fails.
    """
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-i",
                input_path,
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-an",
                "-y",
                output_path,
            ],
            capture_output=True,
            check=True,
            timeout=120,
        )
        return True
    except Exception as exc:
        logger.error(f"[REPORT] Clip transcode failed ({input_path} -> mp4): {exc}")
        return False


def _guess_clip_format(clip_path: str, clip_bytes: Optional[bytes]) -> Tuple[str, str]:
    """
    Returns (extension, content_type), e.g. (".mp4", "video/mp4")
    """
    ext = os.path.splitext(clip_path or "")[1].lower()

    if ext in (".mp4", ".webm", ".avi", ".mov", ".mkv"):
        if ext == ".mp4":
            return ".mp4", "video/mp4"
        if ext == ".webm":
            return ".webm", "video/webm"
        if ext == ".avi":
            return ".avi", "video/x-msvideo"
        if ext == ".mov":
            return ".mov", "video/quicktime"
        return ext, "video/x-matroska"

    if not clip_bytes:
        return ".mp4", "video/mp4"

    head = clip_bytes[:16]
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return ".webm", "video/webm"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return ".mp4", "video/mp4"
    if head.startswith(b"RIFF") and len(head) >= 12 and head[8:12] == b"AVI ":
        return ".avi", "video/x-msvideo"

    return ".mp4", "video/mp4"


def _analyze_clip_with_vlm(clip_bytes: Optional[bytes]) -> str:
    if not clip_bytes:
        return ""
    try:
        payload = {
            "video_b64": base64.b64encode(clip_bytes).decode("utf-8"),
            "prompt": VLM_REPORT_PROMPT,
        }
        resp = requests.post(VLM_ANALYZE_URL, json=payload, timeout=120)
        if resp.status_code != 200:
            logger.error(
                f"[REPORT] VLM summary failed ({resp.status_code}): {resp.text[:200]}"
            )
            return ""
        data = resp.json() if resp.content else {}
        text = str((data or {}).get("text") or "").strip()
        return text[:12000]
    except Exception as exc:
        logger.error(f"[REPORT] VLM summary exception: {exc}")
        return ""


def _upload_or_store(
    uid: str,
    report_id: str,
    key_name: str,
    data: Optional[bytes],
    content_type: str,
) -> str:
    if not data:
        return ""

    from app.r2_storage import is_r2_configured, upload_file as r2_upload

    if not is_r2_configured():
        msg = "[REPORT] R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME."
        if REQUIRE_R2_REPORT_UPLOADS and not ALLOW_LOCAL_REPORT_FALLBACK:
            raise RuntimeError(msg)
        logger.warning(msg + " Falling back to local storage.")
        return _write_local_asset(uid, report_id, key_name, data)

    r2_key = f"reports/{uid}/{report_id}/{key_name}"
    r2_url = r2_upload(r2_key, data, content_type)
    if r2_url:
        return r2_url
    if REQUIRE_R2_REPORT_UPLOADS and not ALLOW_LOCAL_REPORT_FALLBACK:
        raise RuntimeError(f"[REPORT] Failed uploading '{r2_key}' to R2. Aborting report creation.")
    logger.warning(f"[REPORT] Upload failed for '{r2_key}'. Falling back to local storage.")
    return _write_local_asset(uid, report_id, key_name, data)


def create_report(
    uid: str,
    title: str,
    camera_name: str,
    threat_type: str,
    confidence: float,
    vlm_summary: str = "",
    frame_jpeg_bytes: bytes | None = None,
    clip_path: str | None = None,
    clip_bytes: bytes | None = None,
    detections: list | None = None,
    video_offset_seconds: float | None = None,
    stream_id: str = "",
    timestamp_ms: int | None = None,
) -> Dict[str, Any] | None:
    """
    Create a complete incident report and persist metadata.
    """
    from app.report_generator import generate_report_pdf

    report_id = str(uuid.uuid4())
    # Accept either seconds or milliseconds from callers; normalize to ms.
    raw_ts = timestamp_ms if timestamp_ms is not None else int(time.time() * 1000)
    ts_ms = int(raw_ts * 1000) if int(raw_ts) < 1_000_000_000_000 else int(raw_ts)
    ts_utc = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat()
    safe_conf = max(0.0, min(1.0, float(confidence)))

    resolved_clip_path = clip_path or ""
    temp_mp4_path = ""

    # If we received an AVI from live capture, try transcoding for better playback.
    if resolved_clip_path and os.path.isfile(resolved_clip_path):
        ext = os.path.splitext(resolved_clip_path)[1].lower()
        if ext == ".avi":
            temp_mp4_path = resolved_clip_path.rsplit(".", 1)[0] + ".mp4"
            if _transcode_to_mp4(resolved_clip_path, temp_mp4_path) and os.path.isfile(
                temp_mp4_path
            ):
                resolved_clip_path = temp_mp4_path

    resolved_clip_bytes = clip_bytes
    if not resolved_clip_bytes and resolved_clip_path and os.path.isfile(resolved_clip_path):
        try:
            resolved_clip_bytes = _read_file_bytes(resolved_clip_path)
        except Exception as exc:
            logger.error(f"[REPORT] Failed reading clip bytes ({resolved_clip_path}): {exc}")

    summary = (vlm_summary or "").strip()
    if not summary:
        summary = _analyze_clip_with_vlm(resolved_clip_bytes)

    try:
        pdf_bytes = generate_report_pdf(
            title=title,
            camera_name=camera_name,
            timestamp_ms=ts_ms,
            threat_type=threat_type,
            confidence=safe_conf,
            vlm_summary=summary,
            frame_jpeg_bytes=frame_jpeg_bytes,
            detections=detections or [],
            video_offset_seconds=video_offset_seconds,
        )
    except Exception as exc:
        logger.error(f"[REPORT] PDF generation failed: {exc}")
        pdf_bytes = None

    clip_ext, clip_mime = _guess_clip_format(resolved_clip_path, resolved_clip_bytes)
    clip_filename = f"clip{clip_ext}"

    try:
        pdf_url = _upload_or_store(uid, report_id, "report.pdf", pdf_bytes, "application/pdf")
        frame_url = _upload_or_store(uid, report_id, "frame.jpg", frame_jpeg_bytes, "image/jpeg")
        clip_url = _upload_or_store(
            uid,
            report_id,
            clip_filename,
            resolved_clip_bytes,
            clip_mime,
        )
    except Exception as storage_exc:
        logger.error(f"[REPORT] Storage stage failed for report {report_id}: {storage_exc}")
        if temp_mp4_path and os.path.isfile(temp_mp4_path):
            try:
                os.remove(temp_mp4_path)
            except Exception:
                pass
        return None

    report = {
        "id": report_id,
        "uid": uid,
        "title": title,
        "camera_name": camera_name,
        "stream_id": stream_id,
        "threat_type": threat_type,
        "confidence": safe_conf,
        "vlm_summary": summary,
        "timestamp": ts_ms,
        "timestamp_utc": ts_utc,
        "pdf_url": pdf_url,
        "clip_url": clip_url,
        "frame_url": frame_url,
        "clip_mime_type": clip_mime if clip_url else "",
        "video_offset_seconds": float(video_offset_seconds) if video_offset_seconds is not None else None,
        "detections_summary": (detections or [])[:8],
        "created_at": int(time.time() * 1000),
    }

    persisted = False
    try:
        resp = requests.put(
            f"{FIREBASE_RTDB_BASE}/reports/{uid}/{report_id}.json",
            json=report,
            timeout=8,
        )
        persisted = resp.status_code in (200, 201, 204)
        if not persisted:
            logger.error(
                f"[REPORT] Firebase persist failed ({resp.status_code}): {resp.text[:200]}"
            )
    except Exception as exc:
        logger.error(f"[REPORT] Firebase persist exception: {exc}")

    if persisted:
        try:
            from app.notifications import notification_manager

            notification_manager.send_report_generated_email(uid=uid, report=report)
        except Exception as exc:
            logger.error(f"[REPORT] Report email dispatch failed: {exc}")

    if temp_mp4_path and os.path.isfile(temp_mp4_path):
        try:
            os.remove(temp_mp4_path)
        except Exception:
            pass

    logger.info(
        f"[REPORT] Created report id={report_id} uid={uid} threat={threat_type} "
        f"summary={'yes' if bool(summary) else 'no'} clip={'yes' if bool(clip_url) else 'no'} "
        f"pdf={'yes' if bool(pdf_url) else 'no'}"
    )
    return report


def update_report_vlm(
    uid: str, report_id: str, vlm_summary: str, pdf_bytes: bytes | None = None
) -> bool:
    patch: Dict[str, Any] = {
        "vlm_summary": vlm_summary,
        "updated_at": int(time.time() * 1000),
    }

    if pdf_bytes:
        try:
            pdf_url = _upload_or_store(
                uid, report_id, "report.pdf", pdf_bytes, "application/pdf"
            )
            if pdf_url:
                patch["pdf_url"] = pdf_url
        except Exception as storage_exc:
            logger.error(f"[REPORT] update_report_vlm storage failed for {report_id}: {storage_exc}")
            return False

    try:
        resp = requests.patch(
            f"{FIREBASE_RTDB_BASE}/reports/{uid}/{report_id}.json",
            json=patch,
            timeout=8,
        )
        return resp.status_code in (200, 201, 204)
    except Exception as exc:
        logger.error(f"[REPORT] update_report_vlm failed for {report_id}: {exc}")
        return False


def list_reports(uid: str, limit: int = 100) -> list:
    try:
        resp = requests.get(f"{FIREBASE_RTDB_BASE}/reports/{uid}.json", timeout=8)
        if resp.status_code != 200:
            return []
        raw = resp.json() or {}
        if not isinstance(raw, dict):
            return []
        items = list(raw.values())
        items.sort(key=lambda r: r.get("timestamp", 0), reverse=True)
        return items[: max(1, min(limit, 500))]
    except Exception as exc:
        logger.error(f"[REPORT] list_reports failed: {exc}")
        return []


def get_report(uid: str, report_id: str) -> dict | None:
    try:
        resp = requests.get(
            f"{FIREBASE_RTDB_BASE}/reports/{uid}/{report_id}.json", timeout=8
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        return data if isinstance(data, dict) else None
    except Exception as exc:
        logger.error(f"[REPORT] get_report failed: {exc}")
        return None


def delete_report(uid: str, report_id: str) -> bool:
    ok = False
    try:
        resp = requests.delete(
            f"{FIREBASE_RTDB_BASE}/reports/{uid}/{report_id}.json", timeout=8
        )
        ok = resp.status_code in (200, 204)
    except Exception as exc:
        logger.error(f"[REPORT] delete_report failed: {exc}")

    local_dir = os.path.join(REPORTS_DIR, uid, report_id)
    if os.path.isdir(local_dir):
        try:
            shutil.rmtree(local_dir, ignore_errors=True)
        except Exception:
            pass
    return ok
