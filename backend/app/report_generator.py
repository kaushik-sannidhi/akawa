"""
PDF report generator for Akawa incident reports.
"""

import io
import logging
from datetime import datetime, timezone
from typing import Any

from reportlab.lib.colors import HexColor, black
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Image,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

logger = logging.getLogger(__name__)

COLOR_IRON = HexColor("#333333")
COLOR_SILICA = HexColor("#888888")


def _escape_for_paragraph(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    )


def _build_detection_table(doc_width: float, detections: list[dict[str, Any]]) -> Table:
    rows = [["CLASS", "TYPE", "CONF"]]
    for det in detections[:6]:
        rows.append(
            [
                str(det.get("class_name", "unknown")).upper(),
                str(det.get("detection_type", "unknown")).upper(),
                f"{int(float(det.get('confidence', 0.0)) * 100)}%",
            ]
        )
    table = Table(rows, colWidths=[doc_width * 0.42, doc_width * 0.34, doc_width * 0.24])
    table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, 0), "Courier-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Courier"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("TEXTCOLOR", (0, 0), (-1, 0), COLOR_IRON),
                ("TEXTCOLOR", (0, 1), (-1, -1), black),
                ("BACKGROUND", (0, 0), (-1, 0), HexColor("#EFEFEF")),
                ("GRID", (0, 0), (-1, -1), 0.5, COLOR_IRON),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    return table


def generate_report_pdf(
    title: str,
    camera_name: str,
    timestamp_ms: int,
    threat_type: str,
    confidence: float,
    vlm_summary: str,
    frame_jpeg_bytes: bytes | None = None,
    detections: list[dict[str, Any]] | None = None,
    video_offset_seconds: float | None = None,
) -> bytes:
    """
    Build a one-page style incident report PDF with side-by-side frame + AI analysis.
    """
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName="Courier-Bold",
        fontSize=18,
        leading=21,
        textColor=black,
        spaceAfter=2 * mm,
    )
    subtitle_style = ParagraphStyle(
        "Subtitle",
        parent=styles["Normal"],
        fontName="Courier",
        fontSize=8,
        leading=10,
        textColor=COLOR_IRON,
    )
    section_style = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        fontName="Courier-Bold",
        fontSize=10,
        leading=12,
        textColor=black,
        spaceBefore=2 * mm,
        spaceAfter=1 * mm,
    )
    body_style = ParagraphStyle(
        "Body",
        parent=styles["Normal"],
        fontName="Courier",
        fontSize=9,
        leading=12,
        textColor=black,
    )
    footer_style = ParagraphStyle(
        "Footer",
        parent=styles["Normal"],
        fontName="Courier",
        fontSize=7,
        leading=9,
        textColor=COLOR_SILICA,
    )

    threat_label_map = {
        "weapon": "WEAPON DETECTED",
        "violence": "VIOLENT ALTERCATION",
        "fall": "MEDICAL EMERGENCY FALL",
    }
    threat_label = threat_label_map.get((threat_type or "").lower(), (threat_type or "UNKNOWN").upper())
    incident_ts = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S UTC"
    )
    generated_ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    story = []
    story.append(Paragraph("AKAWA INCIDENT REPORT", title_style))
    story.append(Paragraph(f"Generated: {generated_ts}", subtitle_style))

    header_table = Table(
        [
            ["TITLE", title],
            ["THREAT", threat_label],
            ["CONFIDENCE", f"{int(max(0.0, min(1.0, confidence)) * 100)}%"],
            ["CAMERA", camera_name],
            ["TIMESTAMP", incident_ts],
        ] + (
            [["VIDEO OFFSET", f"{video_offset_seconds:.2f}s"]] if video_offset_seconds is not None else []
        ),
        colWidths=[26 * mm, doc.width - 26 * mm],
    )
    header_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (0, -1), "Courier-Bold"),
                ("FONTNAME", (1, 0), (1, -1), "Courier"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("TEXTCOLOR", (0, 0), (0, -1), COLOR_IRON),
                ("TEXTCOLOR", (1, 0), (1, -1), black),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("LINEBELOW", (0, -1), (-1, -1), 0.8, COLOR_IRON),
            ]
        )
    )
    story.append(header_table)
    story.append(Spacer(1, 3 * mm))

    left_col_width = doc.width * 0.52
    right_col_width = doc.width - left_col_width

    if frame_jpeg_bytes:
        try:
            img = Image(io.BytesIO(frame_jpeg_bytes))
            max_w = left_col_width - 8
            max_h = 125 * mm
            ratio = min(max_w / max(img.imageWidth, 1), max_h / max(img.imageHeight, 1))
            img.drawWidth = img.imageWidth * ratio
            img.drawHeight = img.imageHeight * ratio
            left_cell: Any = img
        except Exception as exc:
            logger.error(f"[PDF] Failed embedding frame image: {exc}")
            left_cell = Paragraph("Captured frame unavailable.", body_style)
    else:
        left_cell = Paragraph("Captured frame unavailable.", body_style)

    safe_summary = (vlm_summary or "").strip()
    # Keep the analysis concise enough to preserve one-page layout.
    if len(safe_summary) > 1700:
        safe_summary = f"{safe_summary[:1700].rstrip()}... [TRUNCATED]"
    safe_summary = _escape_for_paragraph(safe_summary) if safe_summary else "No VLM analysis available."

    right_flowables: list[Any] = [
        Paragraph("[ AI ANALYSIS ]", section_style),
        Paragraph(safe_summary, body_style),
    ]
    if detections:
        right_flowables.extend(
            [
                Spacer(1, 2 * mm),
                Paragraph("[ DETECTION BREAKDOWN ]", section_style),
                _build_detection_table(right_col_width - 6, detections),
            ]
        )

    two_col = Table([[left_cell, right_flowables]], colWidths=[left_col_width, right_col_width])
    two_col.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LINEAFTER", (0, 0), (0, 0), 0.6, COLOR_IRON),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("BOX", (0, 0), (-1, -1), 0.8, COLOR_IRON),
            ]
        )
    )
    story.append(two_col)

    story.append(Spacer(1, 3 * mm))
    story.append(
        Paragraph(
            "Automatically generated by AKAWA threat detection. Validate all detections with trained personnel.",
            footer_style,
        )
    )

    doc.build(story)
    return buf.getvalue()
