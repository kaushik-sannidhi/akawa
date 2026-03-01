"""
Tests for report_service — specifically local fallback behavior
when R2 storage is not configured.
"""

import os
import sys
import shutil
import importlib
from unittest.mock import patch, MagicMock

import pytest

# Ensure the backend root is on the path so "app.report_service" imports resolve.
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)


class TestLocalFallbackDefault:
    """Verify that ALLOW_LOCAL_REPORT_FALLBACK defaults to True."""

    def test_allow_local_fallback_defaults_to_true(self):
        """When no env var is set, ALLOW_LOCAL_REPORT_FALLBACK should be True."""
        env = os.environ.copy()
        env.pop("ALLOW_LOCAL_REPORT_FALLBACK", None)
        with patch.dict(os.environ, env, clear=True):
            import app.report_service as rs
            rs = importlib.reload(rs)
            assert rs.ALLOW_LOCAL_REPORT_FALLBACK is True

    def test_allow_local_fallback_can_be_disabled(self):
        """Setting env var to 'false' disables the fallback."""
        with patch.dict(os.environ, {"ALLOW_LOCAL_REPORT_FALLBACK": "false"}, clear=False):
            import app.report_service as rs
            rs = importlib.reload(rs)
            assert rs.ALLOW_LOCAL_REPORT_FALLBACK is False


class TestUploadOrStoreLocalFallback:
    """Verify that _upload_or_store falls back to local storage when R2 is not configured."""

    @patch("app.report_service.ALLOW_LOCAL_REPORT_FALLBACK", True)
    @patch("app.report_service.REQUIRE_R2_REPORT_UPLOADS", True)
    def test_falls_back_to_local_when_r2_not_configured(self, tmp_path):
        """When R2 is not configured and local fallback is enabled, files are stored locally."""
        import app.report_service as rs

        # Override REPORTS_DIR to a temp directory
        test_reports_dir = str(tmp_path / "reports")
        os.makedirs(test_reports_dir, exist_ok=True)

        with patch("app.report_service.REPORTS_DIR", test_reports_dir), \
             patch("app.r2_storage.is_r2_configured", return_value=False):
            url = rs._upload_or_store("testuid", "testreport", "report.pdf", b"fake-pdf", "application/pdf")
            assert url != ""
            assert "report.pdf" in url
            # File should exist on disk
            local_path = os.path.join(test_reports_dir, "testuid", "testreport", "report.pdf")
            assert os.path.isfile(local_path)

    @patch("app.report_service.ALLOW_LOCAL_REPORT_FALLBACK", False)
    @patch("app.report_service.REQUIRE_R2_REPORT_UPLOADS", True)
    def test_raises_when_r2_required_and_no_fallback(self):
        """When R2 is required and local fallback disabled, _upload_or_store raises."""
        import app.report_service as rs

        with patch("app.r2_storage.is_r2_configured", return_value=False):
            with pytest.raises(RuntimeError):
                rs._upload_or_store("testuid", "testreport", "report.pdf", b"fake-pdf", "application/pdf")

    def test_empty_data_returns_empty_string(self):
        """When data is None or empty, _upload_or_store returns empty string."""
        import app.report_service as rs
        assert rs._upload_or_store("uid", "rid", "file.pdf", None, "application/pdf") == ""


class TestCreateReportWithLocalFallback:
    """End-to-end test that create_report succeeds with local storage fallback."""

    @patch("app.report_service.ALLOW_LOCAL_REPORT_FALLBACK", True)
    @patch("app.report_service.REQUIRE_R2_REPORT_UPLOADS", True)
    def test_create_report_succeeds_without_r2(self, tmp_path):
        """create_report should succeed using local storage when R2 is unavailable."""
        import app.report_service as rs

        test_reports_dir = str(tmp_path / "reports")
        os.makedirs(test_reports_dir, exist_ok=True)

        mock_firebase_resp = MagicMock()
        mock_firebase_resp.status_code = 200

        with patch("app.report_service.REPORTS_DIR", test_reports_dir), \
             patch("app.r2_storage.is_r2_configured", return_value=False), \
             patch("app.report_service._analyze_clip_with_vlm", return_value="Test VLM summary"), \
             patch("app.report_service.requests.put", return_value=mock_firebase_resp), \
             patch("app.report_service.requests.patch", return_value=mock_firebase_resp):

            report = rs.create_report(
                uid="testuser",
                title="Test Weapon Report",
                camera_name="Test Camera",
                threat_type="weapon",
                confidence=0.92,
                vlm_summary="",
                frame_jpeg_bytes=b"\xff\xd8\xff\xe0" + b"\x00" * 100,  # minimal JPEG-like bytes
                clip_bytes=b"\x1a\x45\xdf\xa3" + b"\x00" * 100,  # WebM magic bytes
                detections=[{"class_name": "gun", "detection_type": "weapon", "confidence": 0.92}],
            )

            assert report is not None
            assert report["uid"] == "testuser"
            assert report["threat_type"] == "weapon"
            assert report["vlm_summary"] == "Test VLM summary"
            assert report["pdf_url"] != ""
