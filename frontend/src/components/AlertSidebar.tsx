"use client";

import { X } from "lucide-react";

const WEAPON_CLASSES = ["rifle", "handgun", "knife", "weapon"];

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
    return (
        <div className="w-full h-full flex flex-col bg-black border-[2px] border-[var(--color-iron)] font-mono text-xs uppercase tracking-widest text-[var(--color-data)]">
            <div className="px-4 py-3 border-b-[2px] border-[var(--color-iron)] flex justify-between items-center bg-[var(--color-dim)]">
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-[var(--color-alert)] animate-pulse" />
                    <span className="font-bold text-[var(--color-silica)]">
                        [ ALERT_LOG // {new Date().toISOString().substring(0, 10)} ]
                    </span>
                </div>
                {alerts.length > 0 && onClearAll && (
                    <button
                        onClick={onClearAll}
                        className="text-[10px] text-[var(--color-alert)] hover:text-white transition-none border-b border-transparent hover:border-white"
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
                            const borderColor = isWeapon
                                ? "border-[var(--color-alert)]"
                                : "border-[var(--color-iron)]";
                            const textColor = isWeapon
                                ? "text-[var(--color-alert)]"
                                : "text-[var(--color-data)]";
                            const bgColor = isWeapon
                                ? "bg-[var(--color-alert)]/10"
                                : "bg-[var(--color-dim)]";

                            // Display label: unify weapons under "WEAPON"
                            const displayLabel = isWeapon ? "WEAPON" : alert.class_name.toUpperCase();
                            const displayType = isWeapon ? "[ KINETIC_THREAT ]" : "[ SYS_OBJECT ]";

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
                                        <span className={`font-bold ${textColor}`}>{displayType}</span>
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

                                    {/* VLM Analysis Section */}
                                    {alert.vlmAnalysis && (
                                        <div className="mt-2 border-t border-[var(--color-iron)] pt-2 relative">
                                            {alert.vlmAnalysis === "ANALYZING..." ? (
                                                <div className="flex items-center gap-2 text-[10px] text-[var(--color-data)]">
                                                    <div className="w-1.5 h-1.5 bg-[var(--color-data)] animate-ping rounded-full" />
                                                    <span>VLM_ANALYSIS_IN_PROGRESS...</span>
                                                </div>
                                            ) : (
                                                <div className="bg-black/50 border border-[var(--color-iron)] p-2">
                                                    <span className="text-[8px] text-[var(--color-silica)] font-bold block mb-1 border-b border-[var(--color-iron)] pb-1">[ DEEP_VISION_LOG ]</span>
                                                    <p className="text-[9px] text-[var(--color-data)] leading-relaxed whitespace-pre-wrap max-h-32 overflow-y-auto custom-scrollbar">
                                                        {alert.vlmAnalysis}
                                                    </p>
                                                </div>
                                            )}
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
