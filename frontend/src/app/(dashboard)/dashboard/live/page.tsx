"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AlertSidebar from "@/components/AlertSidebar";
import StreamNode from "@/components/StreamNode";
import StreamDialog from "@/components/StreamDialog";
import { PlusSquare, RefreshCw, Bell, X } from "lucide-react";
import { useTelemetry } from "@/context/TelemetryContext";
import { getBaseUrl } from "@/lib/config";
import { useAuth } from "@/context/AuthContext";
import { analyzeVideoWithVLM } from "@/lib/vlmApi";
import { saveSecurityEventToMemory } from "@/lib/supermemoryClient";

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

const blobToBase64 = (blob?: Blob | null): Promise<string> => {
    if (!blob) return Promise.resolve("");
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.split(",")[1] || "");
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

export default function LiveStreamPage() {
    const { logSysEvent } = useTelemetry();
    const { user, loading } = useAuth();

    const [streams, setStreams] = useState<any[]>([]);
    const [alerts, setAlerts] = useState<any[]>([]);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [primaryStreamId, setPrimaryStreamId] = useState<string | null>(null);
    const [alertsPanelOpen, setAlertsPanelOpen] = useState(false);
    const alertsRef = useRef<any[]>([]);
    const streamsRef = useRef<any[]>([]);

    // Track IDs that are being deleted — prevents them from re-appearing via fetch
    const deletingIdsRef = useRef<Set<string>>(new Set());

    const fetchStreams = useCallback(async () => {
        if (loading || !user?.uid) return;
        try {
            const uid = user.uid;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(`${getBaseUrl()}/api/streams?uid=${uid}&_t=${Date.now()}`, {
                cache: 'no-store',
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.streams) {
                // Filter out any streams that are currently being deleted
                const deleting = deletingIdsRef.current;
                const filtered = deleting.size > 0
                    ? data.streams.filter((s: any) => !deleting.has(s.id))
                    : data.streams;
                setStreams(filtered);
            }
        } catch (err: any) {
            if (err.name !== 'AbortError') {
                console.error("Failed to fetch streams (backend may be unreachable):", err.message);
            }
        }
    }, [loading, user]);

    useEffect(() => {
        if (loading) return;
        fetchStreams();
        const interval = setInterval(fetchStreams, 5000);
        return () => clearInterval(interval);
    }, [fetchStreams, loading]);

    useEffect(() => {
        alertsRef.current = alerts;
    }, [alerts]);

    useEffect(() => {
        streamsRef.current = streams;
    }, [streams]);

    const handleDeleteStream = async (id: string, cascadeDelete: boolean = true) => {
        if (!user?.uid) return;

        // Add to the deleting set so polling won't re-add it
        deletingIdsRef.current.add(id);

        // Optimistic removal
        setStreams(prev => prev.filter(s => s.id !== id));
        logSysEvent(`[WARN] SENSOR PROXY ${id.substring(0, 6).toUpperCase()} TERMINATED`);

        try {
            const uid = user.uid;
            if (cascadeDelete) {
                // Await the full backend delete (which also removes from Firebase)
                const res = await fetch(`${getBaseUrl()}/api/streams/${id}?uid=${uid}`, { method: "DELETE" });
                if (!res.ok) console.warn(`Delete returned HTTP ${res.status}`);
            }
        } catch (err: any) {
            console.error("Failed to delete stream:", err.message);
        }

        // Wait, then re-fetch and clear the guard after an extra grace period
        await new Promise(r => setTimeout(r, 1500));
        await fetchStreams();
        // Keep the guard for a bit longer so subsequent polls don't re-add it
        setTimeout(() => {
            deletingIdsRef.current.delete(id);
        }, 15000);
    };

    const handleDetections = (detections: any[], timestamp: number, streamId: string) => {
        const threats = detections.filter(
            (d: any) =>
                (d.is_threat ||
                    ["gun", "knife", "weapon", "violence", "gunshot", "glassbreak"].includes(d.class_name) ||
                    ["weapon", "fall", "violent_person"].includes(d.detection_type ?? "")) &&
                d.confidence >= 0.45
        );
        const activeEvents = [...threats];

        if (activeEvents.length > 0) {
            setAlerts(prev => {
                const updated = [...prev];
                activeEvents.forEach(event => {
                    const existingIdx = updated.findIndex(a =>
                        a.streamId === streamId &&
                        a.class_name === event.class_name &&
                        a.endTimestamp !== undefined &&
                        (timestamp - a.endTimestamp) <= 3000
                    );

                    if (existingIdx !== -1) {
                        updated[existingIdx] = {
                            ...updated[existingIdx],
                            endTimestamp: Math.max(updated[existingIdx].endTimestamp, timestamp),
                            confidence: Math.max(updated[existingIdx].confidence, event.confidence)
                        };
                    } else {
                        updated.unshift({
                            id: Date.now() + Math.random(),
                            class_name: event.detection_type === "violent_person" ? "violence"
                                : event.detection_type === "fall" ? "fall"
                                    : event.class_name,
                            streamId,
                            confidence: event.confidence,
                            startTimestamp: timestamp,
                            endTimestamp: timestamp,
                            vlmAnalysis: null
                        });
                    }
                });
                return updated.slice(0, 50);
            });
        }
    };

    // Attach backend-generated reports to live alerts so sidebar can show "Open Report"
    useEffect(() => {
        if (!user?.uid) return;

        const syncReportsToAlerts = async () => {
            if (alertsRef.current.length === 0) return;
            try {
                const res = await fetch(`${getBaseUrl()}/api/reports/${user.uid}?limit=80&_t=${Date.now()}`, {
                    cache: "no-store"
                });

                if (!res.ok) return;
                const data = await res.json();
                const reports: any[] = data.reports || [];
                if (reports.length === 0) return;

                setAlerts((prev) =>
                    prev.map((alert) => {
                        if (alert.reportId || !alert.streamId) return alert;
                        const alertTsMs = alert.startTimestamp > 1_000_000_000_000
                            ? Number(alert.startTimestamp)
                            : Number(alert.startTimestamp) * 1000;
                        const expectedThreat = mapClassToThreatType(alert.class_name || "");
                        const matched = reports.find((r) =>
                            r.stream_id === alert.streamId &&
                            Math.abs((r.timestamp || 0) - alertTsMs) <= 45000 &&
                            (r.threat_type || "") === expectedThreat
                        );
                        if (!matched) return alert;
                        return {
                            ...alert,
                            reportStatus: "READY",
                            reportId: matched.id,
                            reportUrl: `/dashboard/reports?reportId=${matched.id}`,
                            reportPdfUrl: matched.pdf_url || "",
                        };
                    })
                );
            } catch {
                // Non-fatal sync path
            }
        };

        syncReportsToAlerts();
        const interval = setInterval(syncReportsToAlerts, 8000);
        return () => clearInterval(interval);
    }, [user?.uid]);

    // Listen for custom event containing the generated WebM clips from live streams
    useEffect(() => {
        const handleClipGenerated = async (e: Event) => {
            const customEvent = e as CustomEvent;
            const { videoId, timestamp, videoBlob, frameBlob } = customEvent.detail;
            const tsMs = timestamp > 1_000_000_000_000 ? Math.round(timestamp) : Math.round(timestamp * 1000);

            // Mark the corresponding alert as currently analyzing
            setAlerts(prev => prev.map(a =>
                (Math.abs(a.startTimestamp - timestamp) < 5000 && !a.vlmAnalysis)
                    ? { ...a, vlmAnalysis: "ANALYZING...", reportStatus: "GENERATING" }
                    : a
            ));

            const response = await analyzeVideoWithVLM({ videoBlob });
            if (response.text) {
                saveSecurityEventToMemory({
                    alertType: 'threat',
                    vlmDescription: response.text,
                    timestamp: new Date().toISOString(),
                    cameraId: videoId
                });
            }
            // Update the alert with the final text
            setAlerts(prev => {
                const updated = prev.map(a =>
                    (Math.abs(a.startTimestamp - timestamp) < 5000 && a.vlmAnalysis === "ANALYZING...")
                        ? { ...a, vlmAnalysis: response.text || null }
                        : a
                );
                return updated;
            });

            const uid = user?.uid;
            if (!uid) return;

            const matchedAlert = alertsRef.current.find((a) => Math.abs((a.startTimestamp ?? 0) - timestamp) < 5000);
            const className = matchedAlert?.class_name || "weapon";
            const confidence = typeof matchedAlert?.confidence === "number" ? matchedAlert.confidence : 0.85;
            const threatType = mapClassToThreatType(className);

            const stream = streamsRef.current.find((s) => s.id === videoId);
            const cameraName = stream?.name || "Live Camera";

            try {
                let existingReport: any = null;
                const listResp = await fetch(`${getBaseUrl()}/api/reports/${uid}?limit=60&_t=${Date.now()}`, { cache: "no-store" });
                if (listResp.ok) {
                    const listData = await listResp.json();
                    existingReport = (listData?.reports || []).find((r: any) =>
                        r.stream_id === videoId && Math.abs((r.timestamp || 0) - tsMs) <= 30000
                    );
                }

                const [clipB64, frameB64] = await Promise.all([
                    blobToBase64(videoBlob),
                    blobToBase64(frameBlob),
                ]);

                let finalReport: any = existingReport;

                if (existingReport) {
                    await fetch(`${getBaseUrl()}/api/reports/${uid}/${existingReport.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            uid,
                            report_id: existingReport.id,
                            vlm_summary: response.text || "",
                            title: existingReport.title || makeReportTitle(threatType, cameraName),
                            camera_name: existingReport.camera_name || cameraName,
                            threat_type: existingReport.threat_type || threatType,
                            confidence: existingReport.confidence || confidence,
                            timestamp: existingReport.timestamp || tsMs,
                            frame_b64: frameB64,
                        }),
                    });
                    finalReport = {
                        ...existingReport,
                        vlm_summary: response.text || existingReport.vlm_summary || "",
                    };
                } else {
                    const createResp = await fetch(`${getBaseUrl()}/api/reports`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            uid,
                            title: makeReportTitle(threatType, cameraName),
                            camera_name: cameraName,
                            stream_id: videoId || "",
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
                            timestamp: tsMs,
                        }),
                    });
                    const createData = await createResp.json().catch(() => ({}));
                    finalReport = createData?.report || null;
                }

                setAlerts((prev) =>
                    prev.map((a) =>
                        Math.abs((a.startTimestamp ?? 0) - timestamp) < 5000
                            ? {
                                ...a,
                                reportStatus: finalReport ? "READY" : "FAILED",
                                reportId: finalReport?.id || "",
                                reportUrl: finalReport?.id ? `/dashboard/reports?reportId=${finalReport.id}` : "/dashboard/reports",
                                reportPdfUrl: finalReport?.pdf_url || "",
                            }
                            : a
                    )
                );
            } catch (reportErr) {
                console.error("Failed to create/patch live report:", reportErr);
                setAlerts((prev) =>
                    prev.map((a) =>
                        Math.abs((a.startTimestamp ?? 0) - timestamp) < 5000
                            ? { ...a, reportStatus: "FAILED" }
                            : a
                    )
                );
            }
        };

        window.addEventListener('awca_clip_generated', handleClipGenerated);
        return () => window.removeEventListener('awca_clip_generated', handleClipGenerated);
    }, [user?.uid]);

    const orderedStreams = [...streams].sort((a, b) => {
        if (a.id === primaryStreamId) return -1;
        if (b.id === primaryStreamId) return 1;
        return 0;
    });

    const hasPrimary = primaryStreamId && streams.some(s => s.id === primaryStreamId);

    return (
        <div className="flex flex-col lg:flex-row gap-3 lg:gap-6 h-[calc(100dvh-6rem)] sm:h-[calc(100dvh-8rem)] font-mono uppercase tracking-widest text-[#FFF]">

            <div className="flex-1 flex flex-col gap-3 lg:gap-6 min-h-0">

                <div className="flex items-center justify-between border-[2px] border-[var(--color-iron)] bg-black p-2 sm:p-4 flex-shrink-0">
                    <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                        <span className="font-bold text-[10px] sm:text-xs border-b-[2px] border-white pb-1 hidden sm:inline whitespace-nowrap truncate">[ MATRIX_GRID_CONTROL ]</span>
                        <div className={`px-2 py-1 text-[10px] font-bold border flex items-center gap-2 flex-shrink-0 ${streams.length > 0 ? 'border-[var(--color-alert)] text-[var(--color-alert)] bg-[var(--color-alert)]/10' : 'border-[var(--color-iron)] text-[var(--color-silica)]'}`}>
                            {streams.length > 0 && <span className="w-2 h-2 bg-[var(--color-alert)] animate-pulse" />}
                            {streams.length} ACTIVE
                        </div>
                    </div>

                    <div className="flex items-center gap-2 sm:gap-4">
                        <button
                            onClick={() => setAlertsPanelOpen(!alertsPanelOpen)}
                            className="relative lg:hidden p-2 border border-[var(--color-iron)] hover:border-white text-[var(--color-silica)] transition-colors"
                            title="Toggle Alerts"
                        >
                            <Bell className="w-4 h-4" />
                            {alerts.length > 0 && (
                                <span className="absolute -top-1 -right-1 w-4 h-4 bg-[var(--color-alert)] text-black text-[8px] font-bold flex items-center justify-center">
                                    {alerts.length > 9 ? '9+' : alerts.length}
                                </span>
                            )}
                        </button>
                        <button onClick={() => fetchStreams()} className="p-2 border border-[var(--color-iron)] hover:border-white text-[var(--color-silica)] transition-colors" title="Refresh Feed">
                            <RefreshCw className="w-4 h-4" />
                        </button>
                        <button onClick={() => setIsDialogOpen(true)} className="px-3 sm:px-6 py-2 border-[2px] border-[var(--color-data)] font-bold text-[10px] text-black bg-[var(--color-data)] hover:bg-white transition-none shadow-[4px_4px_0_var(--color-data)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_var(--color-data)] flex items-center gap-2">
                            <PlusSquare className="w-3 h-3" />
                            <span className="hidden sm:inline whitespace-nowrap truncate">[ DEPLOY_SENSOR ]</span>
                            <span className="sm:hidden">DEPLOY</span>
                        </button>
                    </div>
                </div>

                {/* ── Stream Grid ── */}
                {orderedStreams.length === 0 ? (
                    <div className="flex-1 relative bg-black flex flex-col items-center justify-center overflow-hidden border-[2px] border-[var(--color-iron)] min-h-[200px]">
                        <span className="font-bold text-[var(--color-silica)] text-xs sm:text-sm tracking-widest border border-current px-4 py-2 whitespace-nowrap">[ GRID_OFFLINE ]</span>
                    </div>
                ) : orderedStreams.length === 1 ? (
                    /* Single stream — full size */
                    <div className="flex-1 border-[2px] border-[var(--color-iron)] bg-black relative overflow-hidden flex flex-col min-h-[240px]">
                        <StreamNode
                            key={orderedStreams[0].id}
                            stream={orderedStreams[0]}
                            onDelete={handleDeleteStream}
                            onDetections={(detections, timestamp) => handleDetections(detections, timestamp, orderedStreams[0].id)}
                            onSelect={() => setPrimaryStreamId(orderedStreams[0].id)}
                            onDoubleClick={() => setPrimaryStreamId(null)}
                            isPrimary={false}
                        />
                    </div>
                ) : hasPrimary ? (
                    /* Primary + sidebar thumbnails */
                    <div className="flex-1 flex flex-col sm:flex-row gap-[2px] border-[2px] border-[var(--color-iron)] bg-[var(--color-iron)] min-h-[240px] overflow-hidden">
                        {/* Primary — takes ~75% */}
                        <div className="flex-[3] min-h-[200px] sm:min-h-0 relative">
                            <StreamNode
                                key={orderedStreams[0].id}
                                stream={orderedStreams[0]}
                                onDelete={handleDeleteStream}
                                onDetections={(detections, timestamp) => handleDetections(detections, timestamp, orderedStreams[0].id)}
                                onSelect={() => { }}
                                onDoubleClick={() => setPrimaryStreamId(null)}
                                isPrimary={true}
                            />
                        </div>
                        {/* Sidebar thumbnails — takes ~25% */}
                        <div className="flex-1 flex sm:flex-col gap-[2px] overflow-auto min-w-0 sm:min-w-[180px] sm:max-w-[280px]">
                            {orderedStreams.slice(1).map(s => (
                                <div key={s.id} className="flex-1 min-h-[120px] sm:min-h-[140px] relative">
                                    <StreamNode
                                        stream={s}
                                        onDelete={handleDeleteStream}
                                        onDetections={(detections, timestamp) => handleDetections(detections, timestamp, s.id)}
                                        onSelect={() => setPrimaryStreamId(s.id)}
                                        onDoubleClick={() => setPrimaryStreamId(null)}
                                        isPrimary={false}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    /* Even grid — no primary selected */
                    <div className={`flex-1 grid gap-[2px] bg-[var(--color-iron)] border-[2px] border-[var(--color-iron)] overflow-y-auto min-h-[240px] ${orderedStreams.length === 2 ? "grid-cols-1 sm:grid-cols-2" :
                        orderedStreams.length <= 4 ? "grid-cols-2" :
                            "grid-cols-2 lg:grid-cols-3"
                        } auto-rows-[minmax(200px,_1fr)]`}>
                        {orderedStreams.map(s => (
                            <StreamNode
                                key={s.id}
                                stream={s}
                                onDelete={handleDeleteStream}
                                onDetections={(detections, timestamp) => handleDetections(detections, timestamp, s.id)}
                                onSelect={() => setPrimaryStreamId(s.id)}
                                onDoubleClick={() => setPrimaryStreamId(null)}
                                isPrimary={false}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Alert Sidebar — desktop: always visible. Mobile: overlay panel */}
            {/* Desktop sidebar */}
            <div className="hidden lg:block w-80 min-w-[320px] shadow-[var(--shadow-md)]">
                <AlertSidebar
                    alerts={alerts}
                    onClear={(id) => setAlerts(prev => prev.filter(a => a.id !== id))}
                    onClearAll={() => setAlerts([])}
                />
            </div>

            {/* Mobile alerts overlay */}
            {alertsPanelOpen && (
                <div className="fixed inset-0 z-50 lg:hidden">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setAlertsPanelOpen(false)} />
                    <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-[#0A0A0A] border-l-[2px] border-[var(--color-iron)] shadow-xl overflow-y-auto">
                        <div className="flex items-center justify-between p-3 border-b-[2px] border-[var(--color-iron)]">
                            <span className="font-mono text-xs font-bold text-[var(--color-data)] whitespace-nowrap truncate">[ THREAT_LOG ]</span>
                            <button onClick={() => setAlertsPanelOpen(false)} className="p-1 text-[var(--color-silica)] hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <AlertSidebar
                            alerts={alerts}
                            onClear={(id) => setAlerts(prev => prev.filter(a => a.id !== id))}
                            onClearAll={() => setAlerts([])}
                        />
                    </div>
                </div>
            )}

            <StreamDialog
                isOpen={isDialogOpen}
                onClose={() => setIsDialogOpen(false)}
                onStreamAdded={(newStream) => {
                    if (newStream?.id) {
                        setStreams(prev => {
                            const exists = prev.some(s => s.id === newStream.id);
                            return exists ? prev : [newStream, ...prev];
                        });
                    }
                    fetchStreams();
                    logSysEvent("[INFO] SENSOR PROXY DEPLOYED TO THREAT MATRIX");
                }}
            />
        </div>
    );
}
