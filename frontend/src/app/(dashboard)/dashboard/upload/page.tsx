"use client";

import { useState, useEffect, useRef } from "react";
import VideoUpload from "@/components/VideoUpload";
import VideoPlayer from "@/components/VideoPlayer";
import AlertSidebar from "@/components/AlertSidebar";
import { getBaseUrl } from "@/lib/config";
import { useSettings } from "@/context/SettingsContext";
import { useTelemetry } from "@/context/TelemetryContext";
import { auth } from "@/lib/firebase";
import { Bell, X } from "lucide-react";
import { analyzeVideoWithVLM } from "@/lib/vlmApi";

const WEAPON_CLASSES = ["gun", "knife", "violence"];
const WEAPON_ALERT_CONFIDENCE_THRESHOLD = 0.85;

const mapClassToThreatType = (className: string): "weapon" | "violence" | "fall" => {
    const normalized = (className || "").toLowerCase();
    if (normalized === "fall") return "fall";
    if (normalized === "violence" || normalized === "fight" || normalized === "violent_person") return "violence";
    return "weapon";
};

const makeReportTitle = (threatType: "weapon" | "violence" | "fall", sourceLabel: string) => {
    if (threatType === "fall") return `Medical Emergency Fall Detected - ${sourceLabel}`;
    if (threatType === "violence") return `Violent Altercation Detected - ${sourceLabel}`;
    return `Weapon Detected - ${sourceLabel}`;
};

const blobToBase64 = async (blob?: Blob | null): Promise<string> => {
    if (!blob) return "";
    const buffer = await blob.arrayBuffer();
    return btoa(
        new Uint8Array(buffer).reduce((acc, byte) => acc + String.fromCharCode(byte), "")
    );
};

export default function UploadAnalysisPage() {
    const [videoData, setVideoData] = useState<any>(null);
    const [pendingUploadData, setPendingUploadData] = useState<any>(null);
    const [alerts, setAlerts] = useState<any[]>([]);
    const [alertsPanelOpen, setAlertsPanelOpen] = useState(false);
    const { confidenceThreshold, selectedModel } = useSettings();
    const { logSysEvent } = useTelemetry();

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
        setPendingUploadData(data);
    };

    const confirmAlerts = (wantsAlerts: boolean) => {
        setVideoData({ ...pendingUploadData, sendAlerts: wantsAlerts });
        setAlerts([]);
        setPendingUploadData(null);
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
                    send_alerts: videoData?.sendAlerts || false,
                    alerts: alertsList.map((a) => ({
                        class_name: a.class_name,
                        confidence: a.confidence,
                        startTimestamp: a.startTimestamp,
                        endTimestamp: a.endTimestamp,
                        vlm_analysis: a.vlmAnalysis || null,
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
    const videoDataRef = useRef<any>(null);

    useEffect(() => {
        alertsRef.current = alerts;
    }, [alerts]);

    useEffect(() => {
        videoDataRef.current = videoData;
    }, [videoData]);

    const debouncedSave = (alertsList: any[]) => {
        alertsRef.current = alertsList;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            if (videoData?.video_id) {
                saveAlertsToFirebase(alertsRef.current, videoData.video_id);
            }
        }, 3000);
    };

    // Listen for custom event containing the generated WebM clips
    useEffect(() => {
        const handleClipGenerated = async (e: Event) => {
            const customEvent = e as CustomEvent;
            const { videoId, timestamp, videoBlob, frameBlob } = customEvent.detail;

            // Ensure this clip belongs to the active video
            if (videoDataRef.current?.video_id !== videoId) return;

            // Mark the corresponding alert as currently analyzing
            setAlerts(prev => prev.map(a =>
                (Math.abs(a.startTimestamp - timestamp) < 5.0 && !a.vlmAnalysis)
                    ? { ...a, vlmAnalysis: "ANALYZING...", reportStatus: "GENERATING" }
                    : a
            ));

            const response = await analyzeVideoWithVLM({ videoBlob });

            // Update the alert with the final text
            setAlerts(prev => {
                const updated = prev.map(a =>
                    (Math.abs(a.startTimestamp - timestamp) < 5.0 && a.vlmAnalysis === "ANALYZING...")
                        ? { ...a, vlmAnalysis: response.text || `[VLM ERROR] ${response.error}` }
                        : a
                );
                debouncedSave(updated);
                return updated;
            });

            // Create an official incident report with clip/frame + summary.
            const uid = auth.currentUser?.uid;
            const currentVideo = videoDataRef.current;
            if (!uid || !currentVideo) return;

            const matchedAlert =
                alertsRef.current.find((a) => Math.abs((a.startTimestamp ?? 0) - timestamp) < 5.0) || null;
            const className = matchedAlert?.class_name || "weapon";
            const confidence = typeof matchedAlert?.confidence === "number" ? matchedAlert.confidence : 0.85;
            const threatType = mapClassToThreatType(className);

            try {
                const [clipB64, frameB64] = await Promise.all([
                    blobToBase64(videoBlob),
                    blobToBase64(frameBlob),
                ]);

                const reportResp = await fetch(`${getBaseUrl()}/api/reports`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        uid,
                        title: makeReportTitle(threatType, currentVideo.filename || "Uploaded Video"),
                        camera_name: currentVideo.filename || "Uploaded Video",
                        stream_id: `upload_${currentVideo.video_id}`,
                        threat_type: threatType,
                        confidence,
                        vlm_summary: response.text || "",
                        frame_b64: frameB64,
                        clip_b64: clipB64,
                        detections: [
                            {
                                class_name: className,
                                detection_type: threatType === "fall"
                                    ? "fall"
                                    : threatType === "violence"
                                        ? "violent_person"
                                        : "weapon",
                                confidence,
                            },
                        ],
                        video_offset_seconds: Number(timestamp),
                        timestamp: Date.now(),
                    }),
                });

                const reportData = await reportResp.json().catch(() => ({}));
                const report = reportData?.report;

                setAlerts((prev) =>
                    prev.map((a) =>
                        Math.abs((a.startTimestamp ?? 0) - timestamp) < 5.0
                            ? {
                                ...a,
                                reportStatus: report ? "READY" : "FAILED",
                                reportId: report?.id || "",
                                reportUrl: report?.id ? `/dashboard/reports?reportId=${report.id}` : "/dashboard/reports",
                                reportPdfUrl: report?.pdf_url || "",
                            }
                            : a
                    )
                );
            } catch (reportErr) {
                console.error("Failed to create upload incident report:", reportErr);
                setAlerts((prev) =>
                    prev.map((a) =>
                        Math.abs((a.startTimestamp ?? 0) - timestamp) < 5.0
                            ? { ...a, reportStatus: "FAILED" }
                            : a
                    )
                );
            }
        };

        window.addEventListener('awca_clip_generated', handleClipGenerated);
        return () => window.removeEventListener('awca_clip_generated', handleClipGenerated);
    }, [videoData?.video_id]);

    const handleNewAlerts = (detections: any[], timestamp: number) => {
        // Filter for weapon/threat classes above the threshold
        const newThreats = detections.filter(
            (d) => {
                const isWeapon = WEAPON_CLASSES.includes(d.class_name) || d.detection_type === "weapon" || d.class_name === "gun" || d.class_name === "knife";
                const isViolence = d.class_name === "violence" || d.detection_type === "violent_person";
                const isFall = d.detection_type === "fall";
                // Weapons require high confidence; violence/fall use localThreshold
                if (isWeapon) return d.confidence >= WEAPON_ALERT_CONFIDENCE_THRESHOLD;
                return (isViolence || isFall || d.is_threat) && d.confidence >= localThreshold;
            }
        );

        if (newThreats.length > 0) {
            // Log to SYS.LOG so the dashboard shows live threat activity
            newThreats.forEach((event) => {
                const isWeapon = ["gun", "knife", "weapon"].includes(event.class_name) || event.detection_type === "weapon";
                const isViolence = event.class_name === "violence" || event.detection_type === "violent_person";
                const label = isWeapon ? "WEAPON" : isViolence ? "VIOLENCE" : (event.class_name || "THREAT").toUpperCase();
                logSysEvent(`[WARN] ANOMALY DETECTED — ${label} @ ${timestamp.toFixed(1)}s [CONF: ${(event.confidence * 100).toFixed(0)}%]`);
            });

            setAlerts((prev) => {
                const updated = [...prev];
                newThreats.forEach((event) => {
                    // Map detection types to standardized classes for the UI
                    const isWeaponType = ["gun", "knife", "weapon"].includes(event.class_name) || event.detection_type === "weapon";
                    const isViolence = event.class_name === "violence" || event.detection_type === "violent_person";
                    const isFall = event.class_name === "fall" || event.detection_type === "fall";

                    let mappedClass = event.class_name;
                    if (isWeaponType && !["gun", "knife"].includes(event.class_name)) mappedClass = "gun";
                    else if (isViolence) mappedClass = "violence";
                    else if (isFall) mappedClass = "fall";

                    const existingIdx = updated.findIndex(
                        (a) =>
                            a.class_name === mappedClass &&
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
                            class_name: mappedClass,
                            confidence: event.confidence,
                            startTimestamp: timestamp,
                            endTimestamp: timestamp,
                            vlmAnalysis: null,
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
                        <div className="p-4 border-b-[2px] border-[var(--color-iron)] bg-[var(--color-dim)] font-bold text-xs whitespace-nowrap">
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

                                {/* Alert Confirmation Popup overlaying the uploader */}
                                {pendingUploadData && (
                                    <div className="absolute inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
                                        <div className="bg-[#050505] border-[2px] border-[var(--color-alert)] p-6 sm:p-8 w-full max-w-md shadow-[8px_8px_0_var(--color-alert)] text-center relative">
                                            <div className="absolute top-0 left-0 w-2 h-2 border-t-[2px] border-l-[2px] border-[var(--color-alert)] -translate-x-[2px] -translate-y-[2px]" />
                                            <div className="absolute bottom-0 right-0 w-2 h-2 border-b-[2px] border-r-[2px] border-[var(--color-alert)] translate-x-[2px] translate-y-[2px]" />

                                            <h3 className="text-xl font-bold text-[var(--color-alert)] mb-4 whitespace-nowrap">[ ALERT_CONFIG ]</h3>
                                            <p className="text-[10px] sm:text-xs text-[var(--color-silica)] mb-8">
                                                DO YOU WANT TO RECEIVE NOTIFICATIONS (EMAIL/DISCORD/WHATSAPP/SIGNAL) IF A WEAPON OR ANOMALY IS DETECTED IN THIS UPLOAD PERIOD?
                                            </p>
                                            <div className="flex gap-4 justify-center">
                                                <button
                                                    onClick={() => confirmAlerts(true)}
                                                    className="px-6 py-3 font-bold border-[2px] border-[var(--color-alert)] text-[var(--color-alert)] hover:bg-[var(--color-alert)] hover:text-black transition-none uppercase shadow-[4px_4px_0_var(--color-alert)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_var(--color-alert)] whitespace-nowrap"
                                                >
                                                    [ YES ]
                                                </button>
                                                <button
                                                    onClick={() => confirmAlerts(false)}
                                                    className="px-6 py-3 font-bold border-[2px] border-[var(--color-iron)] text-[var(--color-silica)] hover:border-white hover:text-white transition-none uppercase shadow-[4px_4px_0_var(--color-iron)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_var(--color-iron)] whitespace-nowrap"
                                                >
                                                    [ NO ]
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
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
                                <p className="text-[10px] text-[var(--color-silica)] mt-1 whitespace-nowrap truncate">
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
                                    className="px-3 sm:px-4 py-2 text-[10px] font-bold border-[2px] border-[var(--color-iron)] hover:border-[var(--color-data)] hover:bg-[var(--color-data)] hover:text-black transition-none uppercase shadow-[4px_4px_0_var(--color-iron)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_var(--color-iron)] text-[var(--color-silica)] whitespace-nowrap flex-shrink-0"
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
