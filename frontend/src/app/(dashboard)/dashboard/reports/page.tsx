"use client";

import { useAuth } from "@/context/AuthContext";
import { getBaseUrl } from "@/lib/config";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FileText, Download, Play, Trash2, Filter, RefreshCw, AlertTriangle, Swords, HeartPulse, ChevronDown, X, Eye } from "lucide-react";

interface Report {
    id: string;
    uid: string;
    title: string;
    camera_name: string;
    stream_id: string;
    threat_type: string;
    confidence: number;
    vlm_summary: string;
    timestamp: number;
    pdf_url: string;
    clip_url: string;
    frame_url: string;
    video_offset_seconds?: number | null;
    created_at: number;
}

const THREAT_CONFIG: Record<string, { label: string; color: string; icon: typeof AlertTriangle }> = {
    weapon: { label: "WEAPON", color: "var(--color-alert)", icon: AlertTriangle },
    violence: { label: "VIOLENCE", color: "#FF8800", icon: Swords },
    fall: { label: "MED EMERGENCY", color: "#FFD600", icon: HeartPulse },
};

export default function ReportsPage() {
    const { user } = useAuth();
    const searchParams = useSearchParams();
    const preselectedReportId = searchParams.get("reportId");
    const [reports, setReports] = useState<Report[]>([]);
    const [loading, setLoading] = useState(true);
    const [filterType, setFilterType] = useState<string>("all");
    const [filterOpen, setFilterOpen] = useState(false);
    const [expandedReport, setExpandedReport] = useState<string | null>(null);
    const [playingClip, setPlayingClip] = useState<string | null>(null);

    const fetchReports = useCallback(async () => {
        if (!user?.uid) return;
        try {
            const res = await fetch(`${getBaseUrl()}/api/reports/${user.uid}?limit=200&_t=${Date.now()}`, {
                cache: "no-store",
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setReports(data.reports || []);
        } catch (err) {
            console.error("Failed to fetch reports:", err);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        fetchReports();
        const interval = setInterval(fetchReports, 15000);
        return () => clearInterval(interval);
    }, [fetchReports]);

    useEffect(() => {
        if (!preselectedReportId || reports.length === 0) return;
        const exists = reports.some((r) => r.id === preselectedReportId);
        if (exists) {
            setExpandedReport(preselectedReportId);
        }
    }, [preselectedReportId, reports]);

    const handleDelete = async (reportId: string) => {
        if (!user?.uid) return;
        setReports(prev => prev.filter(r => r.id !== reportId));
        try {
            await fetch(`${getBaseUrl()}/api/reports/${user.uid}/${reportId}`, { method: "DELETE" });
        } catch (err) {
            console.error("Failed to delete report:", err);
            fetchReports();
        }
    };

    const resolveUrl = (url: string) => {
        if (!url) return "";
        if (url.startsWith("http")) return url;
        return `${getBaseUrl()}${url}`;
    };

    const filteredReports = filterType === "all"
        ? reports
        : reports.filter(r => r.threat_type === filterType);

    const normalizeTsMs = (value: number) => {
        const n = Number(value || 0);
        if (n <= 0) return 0;
        return n < 1_000_000_000_000 ? Math.round(n * 1000) : Math.round(n);
    };

    const formatTimestampLocal = (ms: number) => {
        const d = new Date(normalizeTsMs(ms));
        return d.toLocaleString("en-US", {
            year: "numeric", month: "short", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false,
        });
    };

    const formatTimestampUtc = (ms: number) => {
        const d = new Date(normalizeTsMs(ms));
        if (!Number.isFinite(d.getTime())) return "INVALID_TIMESTAMP";
        return d.toISOString().replace("T", " ").replace("Z", " UTC");
    };

    return (
        <div className="flex flex-col gap-4 h-full font-mono text-sm uppercase tracking-widest">

            {/* Header bar */}
            <div className="flex items-center justify-between border-[2px] border-[var(--color-iron)] bg-black p-3 sm:p-4 flex-shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <FileText className="w-4 h-4 text-[var(--color-data)] flex-shrink-0" />
                    <span className="font-bold text-[10px] sm:text-xs text-[var(--color-data)] border-b-[2px] border-[var(--color-data)] pb-1 hidden sm:inline">
                        [ INCIDENT_REPORTS ]
                    </span>
                    <div className={`px-2 py-1 text-[10px] font-bold border flex items-center gap-2 flex-shrink-0 ${filteredReports.length > 0
                            ? "border-[var(--color-alert)] text-[var(--color-alert)] bg-[var(--color-alert)]/10"
                            : "border-[var(--color-iron)] text-[var(--color-silica)]"
                        }`}>
                        {filteredReports.length} REPORTS
                    </div>
                </div>

                <div className="flex items-center gap-2 sm:gap-3">
                    {/* Filter dropdown */}
                    <div className="relative">
                        <button
                            onClick={() => setFilterOpen(!filterOpen)}
                            className="flex items-center gap-1 px-2 py-1.5 border border-[var(--color-iron)] hover:border-[var(--color-data)] text-[10px] text-[var(--color-silica)] hover:text-[var(--color-data)] transition-none"
                        >
                            <Filter className="w-3 h-3" />
                            <span className="hidden sm:inline">{filterType === "all" ? "ALL" : filterType.toUpperCase()}</span>
                            <ChevronDown className="w-3 h-3" />
                        </button>
                        {filterOpen && (
                            <>
                                <div className="fixed inset-0 z-30" onClick={() => setFilterOpen(false)} />
                                <div className="absolute right-0 top-full mt-1 z-40 border-[2px] border-[var(--color-iron)] bg-black min-w-[140px]">
                                    {[{ key: "all", label: "ALL TYPES" }, { key: "weapon", label: "WEAPON" }, { key: "violence", label: "VIOLENCE" }, { key: "fall", label: "FALL / MED" }].map(opt => (
                                        <button
                                            key={opt.key}
                                            onClick={() => { setFilterType(opt.key); setFilterOpen(false); }}
                                            className={`w-full text-left px-3 py-2 text-[10px] border-b border-[var(--color-iron)] last:border-b-0 ${filterType === opt.key ? "bg-[var(--color-data)] text-black" : "text-[var(--color-silica)] hover:text-white hover:bg-[var(--color-dim)]"}`}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    <button
                        onClick={() => { setLoading(true); fetchReports(); }}
                        className="p-2 border border-[var(--color-iron)] hover:border-white text-[var(--color-silica)] hover:text-white transition-none"
                        title="Refresh"
                    >
                        <RefreshCw className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Report list */}
            {loading ? (
                <div className="flex-1 flex items-center justify-center">
                    <span className="text-[var(--color-silica)] text-xs animate-pulse">[ LOADING_REPORTS... ]</span>
                </div>
            ) : filteredReports.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center border-[2px] border-[var(--color-iron)] bg-black">
                    <FileText className="w-8 h-8 text-[var(--color-iron)] mb-4" />
                    <span className="text-[var(--color-silica)] text-xs">[ NO_INCIDENT_REPORTS ]</span>
                    <span className="text-[var(--color-iron)] text-[10px] mt-2">Reports are auto-generated when threats are detected</span>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 pb-4">
                    {filteredReports.map(report => {
                        const config = THREAT_CONFIG[report.threat_type] || THREAT_CONFIG.weapon;
                        const Icon = config.icon;
                        const isExpanded = expandedReport === report.id;
                        const isPlaying = playingClip === report.id;

                        return (
                            <div
                                key={report.id}
                                className="border-[2px] border-[var(--color-iron)] bg-black hover:border-[var(--color-silica)] transition-none group"
                            >
                                {/* Report header row */}
                                <div
                                    className="flex items-start gap-3 p-4 cursor-pointer"
                                    onClick={() => setExpandedReport(isExpanded ? null : report.id)}
                                >
                                    {/* Threat icon */}
                                    <div
                                        className="w-10 h-10 border-[2px] flex items-center justify-center flex-shrink-0 mt-0.5"
                                        style={{ borderColor: config.color, color: config.color }}
                                    >
                                        <Icon className="w-5 h-5" />
                                    </div>

                                    {/* Main info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap mb-1">
                                            <span
                                                className="text-[10px] font-bold px-2 py-0.5 border"
                                                style={{ borderColor: config.color, color: config.color }}
                                            >
                                                {config.label}
                                            </span>
                                            <span className="text-[10px] text-[var(--color-silica)] border border-[var(--color-iron)] px-2 py-0.5">
                                                {(report.confidence * 100).toFixed(0)}%
                                            </span>
                                        </div>
                                        <h3 className="text-xs sm:text-sm font-bold text-[var(--color-data)] normal-case tracking-normal leading-snug mb-1 truncate">
                                            {report.title}
                                        </h3>
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[var(--color-silica)]">
                                            <span>CAM: {report.camera_name}</span>
                                            <span>LOCAL: {formatTimestampLocal(report.timestamp)}</span>
                                            <span>UTC: {formatTimestampUtc(report.timestamp)}</span>
                                            {typeof report.video_offset_seconds === "number" && (
                                                <span>OFFSET: {report.video_offset_seconds.toFixed(2)}s</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Expand indicator */}
                                    <ChevronDown className={`w-4 h-4 text-[var(--color-silica)] flex-shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                                </div>

                                {/* Expanded details */}
                                {isExpanded && (
                                    <div className="border-t-[2px] border-[var(--color-iron)]">

                                        {/* Video clip + frame snapshot row */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-0 border-b border-[var(--color-iron)]">

                                            {/* Video clip */}
                                            {report.clip_url ? (
                                                <div className="p-4 border-b md:border-b-0 md:border-r border-[var(--color-iron)]">
                                                    <span className="text-[8px] text-[var(--color-silica)] font-bold block mb-2">[ ALERT_VIDEO_CLIP ]</span>
                                                    {isPlaying ? (
                                                        <div className="relative">
                                                            <video
                                                                src={resolveUrl(report.clip_url)}
                                                                controls
                                                                autoPlay
                                                                className="w-full max-h-[280px] bg-black border border-[var(--color-iron)]"
                                                            />
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); setPlayingClip(null); }}
                                                                className="absolute top-2 right-2 p-1 bg-black/80 border border-[var(--color-iron)] text-[var(--color-silica)] hover:text-white"
                                                            >
                                                                <X className="w-3 h-3" />
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); setPlayingClip(report.id); }}
                                                            className="w-full h-[140px] border border-[var(--color-iron)] bg-[var(--color-dim)] flex flex-col items-center justify-center gap-2 hover:bg-[var(--color-void)] transition-none group/play"
                                                        >
                                                            {report.frame_url ? (
                                                                <div className="relative w-full h-full">
                                                                    <img
                                                                        src={resolveUrl(report.frame_url)}
                                                                        alt="Alert frame"
                                                                        className="w-full h-full object-cover opacity-60"
                                                                    />
                                                                    <div className="absolute inset-0 flex items-center justify-center">
                                                                        <div className="w-10 h-10 border-2 border-[var(--color-data)] flex items-center justify-center bg-black/60">
                                                                            <Play className="w-5 h-5 text-[var(--color-data)]" />
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <>
                                                                    <Play className="w-6 h-6 text-[var(--color-silica)] group-hover/play:text-[var(--color-data)]" />
                                                                    <span className="text-[10px] text-[var(--color-silica)] group-hover/play:text-[var(--color-data)]">PLAY CLIP</span>
                                                                </>
                                                            )}
                                                        </button>
                                                    )}
                                                </div>
                                            ) : report.frame_url ? (
                                                <div className="p-4 border-b md:border-b-0 md:border-r border-[var(--color-iron)]">
                                                    <span className="text-[8px] text-[var(--color-silica)] font-bold block mb-2">[ CAPTURED_FRAME ]</span>
                                                    <img
                                                        src={resolveUrl(report.frame_url)}
                                                        alt="Alert frame"
                                                        className="w-full max-h-[280px] object-contain border border-[var(--color-iron)] bg-[var(--color-dim)]"
                                                    />
                                                </div>
                                            ) : null}

                                            {/* VLM summary */}
                                            <div className="p-4">
                                                <span className="text-[8px] text-[var(--color-silica)] font-bold block mb-2">[ AI_ANALYSIS ]</span>
                                                {report.vlm_summary ? (
                                                    <p className="text-[11px] text-[var(--color-data)] leading-relaxed normal-case tracking-normal whitespace-pre-wrap max-h-[260px] overflow-y-auto custom-scrollbar">
                                                        {report.vlm_summary}
                                                    </p>
                                                ) : (
                                                    <p className="text-[10px] text-[var(--color-silica)] italic normal-case tracking-normal">
                                                        VLM analysis pending or not available for this incident.
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        {/* Action bar */}
                                        <div className="flex items-center justify-between p-3 bg-[var(--color-dim)]">
                                            <div className="flex items-center gap-2">
                                                {report.pdf_url && (
                                                    <a
                                                        href={resolveUrl(report.pdf_url)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 border border-[var(--color-data)] text-[10px] text-[var(--color-data)] hover:bg-[var(--color-data)] hover:text-black transition-none font-bold"
                                                    >
                                                        <Eye className="w-3 h-3" />
                                                        VIEW PDF
                                                    </a>
                                                )}
                                                {report.pdf_url && (
                                                    <a
                                                        href={resolveUrl(report.pdf_url)}
                                                        download
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 border border-[var(--color-iron)] text-[10px] text-[var(--color-silica)] hover:border-[var(--color-data)] hover:text-[var(--color-data)] transition-none font-bold"
                                                    >
                                                        <Download className="w-3 h-3" />
                                                        DOWNLOAD
                                                    </a>
                                                )}
                                                {report.clip_url && (
                                                    <a
                                                        href={resolveUrl(report.clip_url)}
                                                        download
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 border border-[var(--color-iron)] text-[10px] text-[var(--color-silica)] hover:border-[var(--color-data)] hover:text-[var(--color-data)] transition-none font-bold"
                                                    >
                                                        <Download className="w-3 h-3" />
                                                        CLIP
                                                    </a>
                                                )}
                                            </div>

                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleDelete(report.id); }}
                                                className="flex items-center gap-1 px-3 py-1.5 border border-[var(--color-iron)] text-[10px] text-[var(--color-silica)] hover:border-[var(--color-alert)] hover:text-[var(--color-alert)] transition-none font-bold"
                                            >
                                                <Trash2 className="w-3 h-3" />
                                                DELETE
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

