"use client";

import { getBaseUrl } from "@/lib/config";
import { X } from "lucide-react";

const WEAPON_CLASSES = ["gun", "knife"];
const VIOLENCE_CLASSES = ["violence", "violent_person", "fight"];
const FALL_CLASSES = ["fall"];

export default function AlertSidebar({
    alerts,
    onSeek,
    onClear,
    onClearAll,
}: {
    alerts: any[];
    onSeek?: (time: number) => void;
    onClear?: (id: any) => void;
    onClearAll?: () => void;
}) {
    const resolveAssetUrl = (url: string) => {
        if (!url) return "";
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        if (url.startsWith("/")) return `${getBaseUrl()}${url}`;
        return `${getBaseUrl()}/${url}`;
    };

    return (
        <div className="w-full h-full flex flex-col bg-black border-[2px] border-[var(--color-iron)] font-mono text-xs uppercase tracking-widest text-[var(--color-data)]">
            <div className="px-4 py-3 border-b-[2px] border-[var(--color-iron)] flex justify-between items-center bg-[var(--color-dim)]">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="w-2 h-2 bg-[var(--color-alert)] animate-pulse flex-shrink-0" />
                    <span className="font-bold text-[var(--color-silica)] whitespace-nowrap truncate">
                        [ ALERT_LOG // {new Date().toISOString().substring(0, 10)} ]
                    </span>
                </div>
                {alerts.length > 0 && onClearAll && (
                    <button
                        onClick={onClearAll}
                        className="text-[10px] text-[var(--color-alert)] hover:text-white transition-none border-b border-transparent hover:border-white whitespace-nowrap flex-shrink-0"
                    >
                        [ PURGE_ALL ]
                    </button>
                )}
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                <div className="space-y-4">
                    {alerts.length === 0 ? (
                        <div className="text-[var(--color-silica)] text-[10px] text-center mt-10 opacity-50 flex flex-col items-center animate-float-subtle">
                            <span>AWAITING_TELEMETRY...</span>
                            <span>{">"} _</span>
                        </div>
                    ) : (
                        alerts.map((alert, i) => {
                            const isWeapon = WEAPON_CLASSES.includes(alert.class_name);
                            const isViolence = VIOLENCE_CLASSES.includes(alert.class_name);
                            const isFall = FALL_CLASSES.includes(alert.class_name);
                            const borderColor = isWeapon
                                ? "border-[var(--color-alert)]"
                                : isViolence
                                    ? "border-orange-500"
                                    : isFall
                                        ? "border-yellow-500"
                                        : "border-[var(--color-iron)]";
                            const textColor = isWeapon
                                ? "text-[var(--color-alert)]"
                                : isViolence
                                    ? "text-orange-500"
                                    : isFall
                                        ? "text-yellow-500"
                                        : "text-[var(--color-data)]";
                            const bgColor = isWeapon
                                ? "bg-[var(--color-alert)]/10"
                                : isViolence
                                    ? "bg-orange-500/10"
                                    : isFall
                                        ? "bg-yellow-500/10"
                                        : "bg-[var(--color-dim)]";

                            // Display label: unify weapons under "WEAPON"
                            const displayLabel = isWeapon ? "WEAPON" : alert.class_name.toUpperCase();
                            const displayType = isWeapon
                                ? "[ KINETIC_THREAT ]"
                                : isViolence
                                    ? "[ VIOLENT_ALTERCATION ]"
                                    : isFall
                                        ? "[ MEDICAL_EMERGENCY ]"
                                        : "[ SYS_OBJECT ]";

                            return (
                                <div
                                    key={alert.id || i}
                                    onClick={() =>
                                        onSeek && alert.startTimestamp !== undefined
                                            ? onSeek(alert.startTimestamp)
                                            : undefined
                                    }
                                    className={`p-3 border-[2px] ${borderColor} ${bgColor} hover:bg-[var(--color-void)] transition-none cursor-crosshair relative group flex flex-col gap-2 animate-slide-in-bottom`}
                                >
                                    {onClear && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onClear(alert.id);
                                            }}
                                            className="absolute top-2 right-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-[var(--color-silica)] hover:text-white transition-none bg-black border border-[var(--color-iron)] p-1 z-10"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    )}
                                    <div className="flex items-center justify-between">
                                        <span className={`font-bold ${textColor} whitespace-nowrap`}>{displayType}</span>
                                        <span className="border border-current px-1 text-[10px]">
                                            {(alert.confidence * 100).toFixed(0)}%
                                        </span>
                                    </div>
                                    <div className="text-[10px] text-[var(--color-silica)]">
                                        ID: {displayLabel} ({alert.class_name.toUpperCase()})
                                    </div>
                                    <div className="text-[10px] text-[var(--color-silica)] border-t border-[var(--color-iron)] pt-1 mt-1 flex justify-between">
                                        {alert.startTimestamp !== undefined &&
                                            alert.endTimestamp !== undefined ? (
                                            <span>
                                                TS: {alert.startTimestamp.toFixed(1)}s -{" "}
                                                {alert.endTimestamp.toFixed(1)}s
                                            </span>
                                        ) : (
                                            <span>TS: {alert.timestamp?.toFixed(2)}s</span>
                                        )}
                                        <span className="text-[8px] opacity-50">NODE_01</span>
                                    </div>

                                    {/* Report link section (replaces inline VLM text block) */}
                                    {(alert.reportStatus || alert.reportId || alert.reportUrl || alert.reportPdfUrl || alert.vlmAnalysis === "ANALYZING...") && (
                                        <div className="mt-2 border-t border-[var(--color-iron)] pt-2 relative">
                                            {(alert.reportStatus === "GENERATING" || alert.vlmAnalysis === "ANALYZING...") && (
                                                <div className="flex items-center gap-2 text-[10px] text-[var(--color-data)]">
                                                    <div className="w-1.5 h-1.5 bg-[var(--color-data)] animate-ping rounded-full" />
                                                    <span>GENERATING_INCIDENT_REPORT...</span>
                                                </div>
                                            )}

                                            {alert.reportStatus === "FAILED" && (
                                                <div className="text-[9px] text-[var(--color-alert)] border border-[var(--color-alert)] bg-[var(--color-alert)]/10 px-2 py-1">
                                                    REPORT_GENERATION_FAILED
                                                </div>
                                            )}

                                            {(alert.reportUrl || alert.reportId || alert.reportPdfUrl) && (
                                                <div className="bg-black/50 border border-[var(--color-iron)] p-2">
                                                    <span className="text-[8px] text-[var(--color-silica)] font-bold block mb-1 border-b border-[var(--color-iron)] pb-1 whitespace-nowrap">[ INCIDENT_REPORT ]</span>
                                                    <div className="flex gap-2 flex-wrap">
                                                        <a
                                                            href={alert.reportUrl || (alert.reportId ? `/dashboard/reports?reportId=${alert.reportId}` : "/dashboard/reports")}
                                                            onClick={(e) => e.stopPropagation()}
                                                            className="text-[9px] text-[var(--color-data)] border border-[var(--color-data)] px-2 py-1 hover:bg-[var(--color-data)] hover:text-black transition-none"
                                                        >
                                                            OPEN REPORT
                                                        </a>
                                                        {alert.reportPdfUrl && (
                                                            <a
                                                                href={resolveAssetUrl(alert.reportPdfUrl)}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                onClick={(e) => e.stopPropagation()}
                                                                className="text-[9px] text-[var(--color-silica)] border border-[var(--color-iron)] px-2 py-1 hover:bg-white hover:text-black transition-none"
                                                            >
                                                                VIEW PDF
                                                            </a>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Alert Clip Section */}
                                    {alert.clip && (
                                        <div className="mt-2 border-t border-[var(--color-iron)] pt-2">
                                            <span className="text-[8px] text-[var(--color-silica)] font-bold block mb-1 whitespace-nowrap">[ ALERT_CLIP // {alert.clip.duration_seconds || "?"}s ]</span>
                                            <div className="flex gap-2">
                                                {(alert.clip.clip_url || alert.clip.playback_url) && (
                                                    <a
                                                        href={alert.clip.clip_url || alert.clip.playback_url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="text-[9px] text-[var(--color-data)] border border-[var(--color-iron)] px-2 py-1 hover:bg-[var(--color-data)] hover:text-black transition-none"
                                                    >
                                                        ▶ PLAY
                                                    </a>
                                                )}
                                                {(alert.clip.clip_url || alert.clip.download_url) && (
                                                    <a
                                                        href={alert.clip.clip_url || alert.clip.download_url}
                                                        download
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="text-[9px] text-[var(--color-silica)] border border-[var(--color-iron)] px-2 py-1 hover:bg-white hover:text-black transition-none"
                                                    >
                                                        ↓ SAVE
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
