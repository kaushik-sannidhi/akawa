"use client";

import { useState, useEffect, useRef } from "react";
import VideoUpload from "@/components/VideoUpload";
import VideoPlayer from "@/components/VideoPlayer";
import AlertSidebar from "@/components/AlertSidebar";
import { getBaseUrl } from "@/lib/config";
import { useSettings } from "@/context/SettingsContext";
import { auth } from "@/lib/firebase";
import { Bell, X } from "lucide-react";

const WEAPON_CLASSES = ["rifle", "handgun", "knife", "weapon"];

export default function UploadAnalysisPage() {
    const [videoData, setVideoData] = useState<any>(null);
    const [alerts, setAlerts] = useState<any[]>([]);
    const [alertsPanelOpen, setAlertsPanelOpen] = useState(false);
    const { confidenceThreshold, selectedModel } = useSettings();

    // Local override slider initialized from global settings
    const [localThreshold, setLocalThreshold] = useState<number>(confidenceThreshold);
    const prevGlobal = useRef(confidenceThreshold);

    // Sync local threshold when global changes (e.g. user updates settings page)
    useEffect(() => {
        if (prevGlobal.current !== confidenceThreshold) {
            setLocalThreshold(confidenceThreshold);
            prevGlobal.current = confidenceThreshold;
        }
    }, [confidenceThreshold]);

    const [seekTrigger, setSeekTrigger] = useState<{ time: number; id: number } | null>(null);

    const handleUploadComplete = (data: any) => {
        setVideoData(data);
        setAlerts([]);
    };

    // Persist alerts to Firebase whenever they change
    const saveAlertsToFirebase = async (alertsList: any[], videoId: string) => {
        const uid = auth.currentUser?.uid;
        if (!uid || alertsList.length === 0) return;

        try {
            await fetch(`${getBaseUrl()}/api/alerts`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    uid,
                    video_id: videoId,
                    alerts: alertsList.map((a) => ({
                        class_name: a.class_name,
                        confidence: a.confidence,
                        startTimestamp: a.startTimestamp,
                        endTimestamp: a.endTimestamp,
                    })),
                }),
            });
        } catch (err) {
            console.error("Failed to save alerts to Firebase:", err);
        }
    };

    // Debounce Firebase saves — only save 3s after last alert arrives
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const alertsRef = useRef<any[]>([]);

    const debouncedSave = (alertsList: any[]) => {
        alertsRef.current = alertsList;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            if (videoData?.video_id) {
                saveAlertsToFirebase(alertsRef.current, videoData.video_id);
            }
        }, 3000);
    };

    const handleNewAlerts = (detections: any[], timestamp: number) => {
        // Filter for weapon classes above the threshold
        const newThreats = detections.filter(
            (d) => WEAPON_CLASSES.includes(d.class_name) && d.confidence >= localThreshold
        );

        if (newThreats.length > 0) {
            setAlerts((prev) => {
                const updated = [...prev];
                newThreats.forEach((event) => {
                    const existingIdx = updated.findIndex(
                        (a) =>
                            a.class_name === event.class_name &&
                            a.endTimestamp !== undefined &&
                            timestamp - a.endTimestamp <= 3.0
                    );

                    if (existingIdx !== -1) {
                        updated[existingIdx] = {
                            ...updated[existingIdx],
                            endTimestamp: Math.max(updated[existingIdx].endTimestamp, timestamp),
                            confidence: Math.max(updated[existingIdx].confidence, event.confidence),
                        };
                    } else {
                        updated.unshift({
                            id: Date.now() + Math.random(),
                            class_name: event.class_name,
                            confidence: event.confidence,
                            startTimestamp: timestamp,
                            endTimestamp: timestamp,
                        });
                    }
                });

                const trimmed = updated.slice(0, 50);

                // Debounced save instead of immediate
                debouncedSave(trimmed);

                return trimmed;
            });
        }
    };

    return (
        <div className="flex flex-col lg:flex-row gap-3 lg:gap-6 h-[calc(100dvh-6rem)] sm:h-[calc(100dvh-8rem)] font-mono uppercase tracking-widest text-[#FFF]">

            {/* Left side: Upload/Analysis Matrix */}
            <div className="flex-1 flex flex-col border-[2px] border-[var(--color-iron)] bg-black overflow-hidden relative">

                {!videoData ? (
                    // Ingestion State
                    <div className="flex-1 w-full flex flex-col relative">
                        <div className="p-4 border-b-[2px] border-[var(--color-iron)] bg-[var(--color-dim)] font-bold text-xs">
                            [ ARCHIVE_INGESTION_MODULE ]
                        </div>
                        <div className="flex-1 p-4 sm:p-8 lg:p-16 flex items-center justify-center">
                            <div className="w-full h-full max-w-3xl border-2 border-dashed border-[var(--color-iron)] bg-[#050505] hover:border-[var(--color-data)] hover:bg-[var(--color-dim)] transition-none p-2 relative flex flex-col">
                                {/* Decorators */}
                                <div className="absolute top-0 left-0 w-4 h-4 border-t-[2px] border-l-[2px] border-[var(--color-data)] -translate-x-[2px] -translate-y-[2px]" />
                                <div className="absolute top-0 right-0 w-4 h-4 border-t-[2px] border-r-[2px] border-[var(--color-data)] translate-x-[2px] -translate-y-[2px]" />
                                <div className="absolute bottom-0 left-0 w-4 h-4 border-b-[2px] border-l-[2px] border-[var(--color-data)] -translate-x-[2px] translate-y-[2px]" />
                                <div className="absolute bottom-0 right-0 w-4 h-4 border-b-[2px] border-r-[2px] border-[var(--color-data)] translate-x-[2px] translate-y-[2px]" />

                                <div className="flex-1 w-full flex items-center justify-center relative z-10">
                                    <VideoUpload onUploadComplete={handleUploadComplete} />
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    // Analysis State
                    <div className="w-full h-full flex flex-col">

                        {/* Control Strip */}
                        <div className="flex items-center justify-between gap-3 border-b-[2px] border-[var(--color-iron)] bg-black p-3 sm:p-4 shrink-0">
                            <div className="min-w-0">
                                <h2 className="font-bold text-xs sm:text-sm bg-[var(--color-data)] text-black inline-block px-2 max-w-full truncate">{videoData.filename}</h2>
                                <p className="text-[10px] text-[var(--color-silica)] mt-1">
                                    [ LEN: {videoData.duration?.toFixed(2)}s | FPS: {videoData.fps?.toFixed(0)} | RES: {videoData.resolution?.width}x{videoData.resolution?.height} ]
                                </p>
                            </div>

                            <div className="flex items-center gap-2 sm:gap-6 flex-shrink-0">
                                <button
                                    onClick={() => setAlertsPanelOpen((prev) => !prev)}
                                    className="relative lg:hidden p-2 border border-[var(--color-iron)] hover:border-white text-[var(--color-silica)] transition-colors"
                                    title="Toggle Alerts"
                                >
                                    <Bell className="w-4 h-4" />
                                    {alerts.length > 0 && (
                                        <span className="absolute -top-1 -right-1 w-4 h-4 bg-[var(--color-alert)] text-black text-[8px] font-bold flex items-center justify-center">
                                            {alerts.length > 9 ? "9+" : alerts.length}
                                        </span>
                                    )}
                                </button>

                                <div className="hidden sm:flex flex-col gap-1 w-32">
                                    <div className="flex justify-between text-[10px] font-bold">
                                        <span className="text-[var(--color-silica)]">CONFIDENCE</span>
                                        <span className="text-[var(--color-alert)]">{(localThreshold * 100).toFixed(0)}%</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="0.1" max="0.95" step="0.05"
                                        value={localThreshold}
                                        onChange={(e) => setLocalThreshold(parseFloat(e.target.value))}
                                        className="w-full appearance-none h-1 bg-[var(--color-dim)] border border-[var(--color-iron)] outline-none cursor-crosshair accent-[var(--color-alert)]"
                                    />
                                </div>

                                <button
                                    onClick={() => setVideoData(null)}
                                    className="px-3 sm:px-4 py-2 text-[10px] font-bold border-[2px] border-[var(--color-iron)] hover:border-[var(--color-data)] hover:bg-[var(--color-data)] hover:text-black transition-none uppercase shadow-[4px_4px_0_var(--color-iron)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_var(--color-iron)] text-[var(--color-silica)]"
                                >
                                    [ CLEAR_BUFFER ]
                                </button>
                            </div>
                        </div>

                        {/* Mobile threshold strip */}
                        <div className="sm:hidden border-b-[2px] border-[var(--color-iron)] bg-[var(--color-dim)] px-3 py-2">
                            <div className="flex justify-between text-[10px] font-bold mb-2">
                                <span className="text-[var(--color-silica)]">CONFIDENCE</span>
                                <span className="text-[var(--color-alert)]">{(localThreshold * 100).toFixed(0)}%</span>
                            </div>
                            <input
                                type="range"
                                min="0.1" max="0.95" step="0.05"
                                value={localThreshold}
                                onChange={(e) => setLocalThreshold(parseFloat(e.target.value))}
                                className="w-full appearance-none h-1 bg-[var(--color-dim)] border border-[var(--color-iron)] outline-none cursor-crosshair accent-[var(--color-alert)]"
                            />
                        </div>

                        {/* Video Forensic Player */}
                        <div className="flex-1 relative bg-[#050505] p-2 sm:p-4 flex items-center justify-center overflow-hidden">
                            <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:32px_32px] opacity-20 pointer-events-none z-0" />

                            <div className="w-full max-w-5xl border-[2px] border-[var(--color-iron)] relative z-10 shadow-2xl">
                                {/* Decorators */}
                                <div className="absolute top-0 left-0 w-2 h-2 border-t-[2px] border-l-[2px] border-[var(--color-data)] -translate-x-[2px] -translate-y-[2px] z-20" />
                                <div className="absolute bottom-0 right-0 w-2 h-2 border-b-[2px] border-r-[2px] border-[var(--color-data)] translate-x-[2px] translate-y-[2px] z-20" />

                                <VideoPlayer
                                    videoId={videoData.video_id}
                                    videoUrl={videoData.file_url}
                                    modelId={selectedModel}
                                    confidenceThreshold={localThreshold}
                                    onAlert={handleNewAlerts}
                                    seekTrigger={seekTrigger}
                                />
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Right Side: Alert Log */}
            {videoData && (
                <div className="hidden lg:block w-80 min-w-[320px] shadow-[var(--shadow-md)] flex-shrink-0">
                    <AlertSidebar
                        alerts={alerts}
                        onSeek={(time) => setSeekTrigger({ time, id: Date.now() })}
                        onClear={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))}
                        onClearAll={() => setAlerts([])}
                    />
                </div>
            )}

            {/* Mobile alerts overlay */}
            {videoData && alertsPanelOpen && (
                <div className="fixed inset-0 z-50 lg:hidden">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setAlertsPanelOpen(false)} />
                    <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-[#0A0A0A] border-l-[2px] border-[var(--color-iron)] shadow-xl overflow-y-auto">
                        <div className="flex items-center justify-between p-3 border-b-[2px] border-[var(--color-iron)]">
                            <span className="font-mono text-xs font-bold text-[var(--color-data)]">[ ALERT_LOG ]</span>
                            <button onClick={() => setAlertsPanelOpen(false)} className="p-1 text-[var(--color-silica)] hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <AlertSidebar
                            alerts={alerts}
                            onSeek={(time) => {
                                setSeekTrigger({ time, id: Date.now() });
                                setAlertsPanelOpen(false);
                            }}
                            onClear={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))}
                            onClearAll={() => setAlerts([])}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
