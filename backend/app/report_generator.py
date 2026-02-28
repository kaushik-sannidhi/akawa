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
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

logger = logging.getLogger(__name__)

COLOR_ALERT = HexColor("#FF3300")
COLOR_DATA = HexColor("#FFFFFF")
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


def generate_report_pdf(
    title: str,
    camera_name: str,
    timestamp_ms: int,
    threat_type: str,
    confidence: float,
    vlm_summary: str,
    frame_jpeg_bytes: bytes | None = None,
    detections: list[dict[str, Any]] | None = None,
) -> bytes:
    """
    Build an incident report PDF in-memory and return raw bytes.
    """
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "ReportTitle",
        parent=styles["Title"],
        fontName="Courier-Bold",
        fontSize=21,
        leading=25,
        textColor=black,
        spaceAfter=3 * mm,
    )
    subtitle_style = ParagraphStyle(
        "ReportSubtitle",
        parent=styles["Normal"],
        fontName="Courier",
        fontSize=9,
        leading=12,
        textColor=COLOR_IRON,
        spaceAfter=2 * mm,
    )
    section_header = ParagraphStyle(
        "SectionHeader",
        parent=styles["Heading2"],
        fontName="Courier-Bold",
        fontSize=11,
        leading=14,
        textColor=black,
        spaceBefore=5 * mm,
        spaceAfter=3 * mm,
    )
    body_style = ParagraphStyle(
        "Body",
        parent=styles["Normal"],
        fontName="Courier",
        fontSize=10,
        leading=14,
        textColor=black,
    )
    small_style = ParagraphStyle(
        "Small",
        parent=styles["Normal"],
        fontName="Courier",
        fontSize=8,
        leading=10,
        textColor=COLOR_SILICA,
    )

    threat_label_map = {
        "weapon": "WEAPON DETECTED",
        "violence": "VIOLENT ALTERCATION",
        "fall": "MEDICAL EMERGENCY FALL",
    }
    threat_label = threat_label_map.get((threat_type or "").lower(), (threat_type or "UNKNOWN").upper())

    incident_ts = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
    incident_ts_str = incident_ts.strftime("%Y-%m-%d %H:%M:%S UTC")
    generated_ts_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    story = []
    story.append(Paragraph("AKAWA INCIDENT REPORT", title_style))
    story.append(Paragraph(f"Generated: {generated_ts_str}", subtitle_style))

    divider = Table([[""]], colWidths=[doc.width])
    divider.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 2, black)]))
    story.append(divider)
    story.append(Spacer(1, 4 * mm))

    story.append(Paragraph("[ INCIDENT DETAILS ]", section_header))
    meta_data = [
        ["TITLE", title],
        ["THREAT TYPE", threat_label],
        ["CONFIDENCE", f"{int(max(0.0, min(1.0, confidence)) * 100)}%"],
        ["CAMERA", camera_name],
        ["TIMESTAMP", incident_ts_str],
    ]
    meta_table = Table(meta_data, colWidths=[38 * mm, doc.width - 38 * mm])
    meta_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (0, -1), "Courier-Bold"),
                ("FONTNAME", (1, 0), (1, -1), "Courier"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("TEXTCOLOR", (0, 0), (0, -1), COLOR_IRON),
                ("TEXTCOLOR", (1, 0), (1, -1), black),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("LINEBELOW", (0, -1), (-1, -1), 0.5, COLOR_IRON),
            ]
        )
    )
    story.append(meta_table)
    story.append(Spacer(1, 4 * mm))

    if detections:
        story.append(Paragraph("[ DETECTION BREAKDOWN ]", section_header))
        rows = [["CLASS", "TYPE", "CONF"]]
        for det in detections[:8]:
            rows.append(
                [
                    str(det.get("class_name", "unknown")).upper(),
                    str(det.get("detection_type", "unknown")).upper(),
                    f"{int(float(det.get('confidence', 0.0)) * 100)}%",
                ]
            )
        det_table = Table(rows, colWidths=[doc.width * 0.4, doc.width * 0.35, doc.width * 0.25])
        det_table.setStyle(
            TableStyle(
                [
                    ("FONTNAME", (0, 0), (-1, 0), "Courier-Bold"),
                    ("FONTNAME", (0, 1), (-1, -1), "Courier"),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    ("TEXTCOLOR", (0, 0), (-1, 0), COLOR_IRON),
                    ("TEXTCOLOR", (0, 1), (-1, -1), black),
                    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#EFEFEF")),
                    ("GRID", (0, 0), (-1, -1), 0.5, COLOR_IRON),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        story.append(det_table)
        story.append(Spacer(1, 4 * mm))

    if frame_jpeg_bytes:
        story.append(Paragraph("[ CAPTURED FRAME ]", section_header))
        try:
            img_buf = io.BytesIO(frame_jpeg_bytes)
            img = Image(img_buf)
            max_width = doc.width
            max_height = 110 * mm
            iw, ih = img.imageWidth, img.imageHeight
            ratio = min(max_width / max(iw, 1), max_height / max(ih, 1))
            img.drawWidth = iw * ratio
            img.drawHeight = ih * ratio
            story.append(img)
            story.append(Spacer(1, 4 * mm))
        except Exception as exc:
            logger.error(f"[PDF] Failed embedding frame image: {exc}")

    story.append(Paragraph("[ AI ANALYSIS ]", section_header))
    if (vlm_summary or "").strip():
        story.append(Paragraph(_escape_for_paragraph(vlm_summary), body_style))
    else:
        story.append(Paragraph("No VLM analysis available for this incident.", body_style))

    story.append(Spacer(1, 8 * mm))
    footer_divider = Table([[""]], colWidths=[doc.width])
    footer_divider.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 1, COLOR_IRON)]))
    story.append(footer_divider)
    story.append(Spacer(1, 2 * mm))
    story.append(
        Paragraph(
            (
                "Automatically generated by AKAWA threat detection. "
                "All detections should be validated by trained personnel."
            ),
            small_style,
        )
    )

    doc.build(story)
    return buf.getvalue()
