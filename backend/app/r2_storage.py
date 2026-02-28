"""
Cloudflare R2 storage integration via S3-compatible API (boto3).
Provides helpers to upload files and generate presigned URLs.
"""

import os
import logging
import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME", "akawa-reports")
R2_PUBLIC_URL = os.getenv("R2_PUBLIC_URL", "")  # e.g. https://pub-xxx.r2.dev

_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client

    if not R2_ACCOUNT_ID or not R2_ACCESS_KEY_ID or not R2_SECRET_ACCESS_KEY:
        logger.warning("[R2] Missing R2 credentials — uploads will be skipped")
        return None

    _client = boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )
    return _client


def upload_file(key: str, data: bytes, content_type: str = "application/octet-stream") -> str | None:
    """
    Upload bytes to R2.  Returns the public URL on success, None on failure.
    The key should include the full path, e.g. "reports/<uid>/<id>/clip.mp4"
    """
    client = _get_client()
    if client is None:
        return None

    try:
        client.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=key,
            Body=data,
            ContentType=content_type,
        )
        if R2_PUBLIC_URL:
            return f"{R2_PUBLIC_URL.rstrip('/')}/{key}"
        return f"https://{R2_BUCKET_NAME}.{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{key}"
    except Exception as exc:
        logger.error(f"[R2] Upload failed for key={key}: {exc}")
        return None


def generate_presigned_url(key: str, expires_in: int = 3600) -> str | None:
    """Generate a presigned GET URL for the given key."""
    client = _get_client()
    if client is None:
        return None

    try:
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": R2_BUCKET_NAME, "Key": key},
            ExpiresIn=expires_in,
        )
    except Exception as exc:
        logger.error(f"[R2] Presigned URL failed for key={key}: {exc}")
        return None

