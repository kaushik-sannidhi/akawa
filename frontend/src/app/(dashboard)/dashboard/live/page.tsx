"use client";

import { useCallback, useEffect, useState } from "react";
import AlertSidebar from "@/components/AlertSidebar";
import StreamNode from "@/components/StreamNode";
import StreamDialog from "@/components/StreamDialog";
import { PlusSquare, RefreshCw, Bell, X } from "lucide-react";
import { useTelemetry } from "@/context/TelemetryContext";
import { getBaseUrl } from "@/lib/config";
import { useAuth } from "@/context/AuthContext";

export default function LiveStreamPage() {
    const { logSysEvent } = useTelemetry();
    const { user, loading } = useAuth();

    const [streams, setStreams] = useState<any[]>([]);
    const [alerts, setAlerts] = useState<any[]>([]);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [primaryStreamId, setPrimaryStreamId] = useState<string | null>(null);
    const [alertsPanelOpen, setAlertsPanelOpen] = useState(false);

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
            if (data.streams) setStreams(data.streams);
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

    const handleDeleteStream = async (id: string, cascadeDelete: boolean = true) => {
        if (!user?.uid) return;

        // Optimistic removal first so the UI updates immediately
        setStreams(prev => prev.filter(s => s.id !== id));
        logSysEvent(`[WARN] SENSOR PROXY ${id.substring(0, 6).toUpperCase()} TERMINATED`);

        try {
            const uid = user.uid;
            if (cascadeDelete) {
                const res = await fetch(`${getBaseUrl()}/api/streams/${id}?uid=${uid}`, { method: "DELETE" });
                if (!res.ok) console.warn(`Delete returned HTTP ${res.status}`);
            }
            // Short delay before re-fetching to give the backend time to fully
            // clean up WebSocket connections so the deleted stream doesn't
            // re-appear from a stale list.
            await new Promise(r => setTimeout(r, 600));
            fetchStreams();
        } catch (err: any) {
            console.error("Failed to delete stream:", err.message);
            // Still re-fetch to reconcile state even on error
            fetchStreams();
        }
    };

    const handleDetections = (detections: any[], timestamp: number) => {
        const threats = detections.filter(
            (d: any) => ["rifle", "handgun", "knife", "weapon"].includes(d.class_name) && d.confidence >= 0.45
        );
        const activeEvents = [...threats];

        if (activeEvents.length > 0) {
            setAlerts(prev => {
                const updated = [...prev];
                activeEvents.forEach(event => {
                    const existingIdx = updated.findIndex(a =>
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
                            class_name: event.class_name,
                            confidence: event.confidence,
                            startTimestamp: timestamp,
                            endTimestamp: timestamp
                        });
                    }
                });
                return updated.slice(0, 50);
            });
        }
    };

    const orderedStreams = [...streams].sort((a, b) => {
        if (a.id === primaryStreamId) return -1;
        if (b.id === primaryStreamId) return 1;
        return 0;
    });

    return (
        <div className="flex flex-col lg:flex-row gap-3 lg:gap-6 h-[calc(100dvh-6rem)] sm:h-[calc(100dvh-8rem)] font-mono uppercase tracking-widest text-[#FFF]">

            <div className="flex-1 flex flex-col gap-3 lg:gap-6 min-h-0">

                <div className="flex items-center justify-between border-[2px] border-[var(--color-iron)] bg-black p-2 sm:p-4 flex-shrink-0">
                    <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                        <span className="font-bold text-[10px] sm:text-xs border-b-[2px] border-white pb-1 hidden sm:inline">[ MATRIX_GRID_CONTROL ]</span>
                        <div className={`px-2 py-1 text-[10px] font-bold border flex items-center gap-2 flex-shrink-0 ${streams.length > 0 ? 'border-[var(--color-alert)] text-[var(--color-alert)] bg-[var(--color-alert)]/10' : 'border-[var(--color-iron)] text-[var(--color-silica)]'}`}>
                            {streams.length > 0 && <span className="w-2 h-2 bg-[var(--color-alert)] animate-pulse" />}
                            {streams.length} ACTIVE
                        </div>
                    </div>

                    <div className="flex items-center gap-2 sm:gap-4">
                        {/* Mobile alerts toggle */}
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
                            <span className="hidden sm:inline">[ DEPLOY_SENSOR ]</span>
                            <span className="sm:hidden">DEPLOY</span>
                        </button>
                    </div>
                </div>

                {orderedStreams.length === 0 ? (
                    <div className="flex-1 relative bg-black flex flex-col items-center justify-center overflow-hidden border-[2px] border-[var(--color-iron)] min-h-[200px]">
                        <span className="font-bold text-[var(--color-silica)] text-xs sm:text-sm tracking-widest border border-current px-4 py-2">[ GRID_OFFLINE ]</span>
                    </div>
                ) : orderedStreams.length === 1 ? (
                    <div className="flex-1 border-[2px] border-[var(--color-iron)] bg-black relative overflow-hidden flex flex-col min-h-[240px]">
                        <StreamNode
                            key={orderedStreams[0].id}
                            stream={orderedStreams[0]}
                            onDelete={handleDeleteStream}
                            onDetections={handleDetections}
                            onSelect={() => setPrimaryStreamId(orderedStreams[0].id)}
                            isPrimary={false} // Full width height, no need for span classes
                        />
                    </div>
                ) : orderedStreams.length === 2 ? (
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-[2px] bg-[var(--color-iron)] border-[2px] border-[var(--color-iron)] overflow-y-auto auto-rows-[minmax(240px,_1fr)] min-h-[240px]">
                        {orderedStreams.map((s) => (
                            <StreamNode
                                key={s.id}
                                stream={s}
                                onDelete={handleDeleteStream}
                                onDetections={handleDetections}
                                onSelect={() => setPrimaryStreamId(s.id)}
                                isPrimary={false}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[2px] bg-[var(--color-iron)] border-[2px] border-[var(--color-iron)] overflow-y-auto auto-rows-[minmax(240px,_1fr)] min-h-[240px]">
                        <StreamNode
                            key={orderedStreams[0].id}
                            stream={orderedStreams[0]}
                            onDelete={handleDeleteStream}
                            onDetections={handleDetections}
                            onSelect={() => setPrimaryStreamId(orderedStreams[0].id)}
                            isPrimary={true}
                        />
                        {orderedStreams.slice(1).map(s => (
                            <StreamNode
                                key={s.id}
                                stream={s}
                                onDelete={handleDeleteStream}
                                onDetections={handleDetections}
                                onSelect={() => setPrimaryStreamId(s.id)}
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
                            <span className="font-mono text-xs font-bold text-[var(--color-data)]">[ THREAT_LOG ]</span>
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
