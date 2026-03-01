"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Trash2, Play, Mic, MicOff, Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";
import { WHIPPublisher, WHEPSubscriber } from "@/lib/whip-whep";
import { joinMeeting, type RealtimeSession } from "@/lib/cloudflare-calls";
import {
    RealtimeKitProvider,
    useRealtimeKitMeeting,
    useRealtimeKitSelector
} from "@cloudflare/realtimekit-react";

interface StreamNodeProps {
    stream: any;
    onDelete: (id: string, cascadeDelete: boolean) => void;
    onDetections: (detections: any[], timestamp: number) => void;
    onSelect?: () => void;
    onDoubleClick?: () => void;
    isPrimary?: boolean;
}

/**
 * Hook to handle frame capture and sending to AI backend via WebSocket
 */
function useAiInference(streamId: string, enabled: boolean, videoRef: React.RefObject<HTMLVideoElement | null>, setIsStreaming: (s: boolean) => void) {
    useEffect(() => {
        if (!enabled) return;

        let alive = true;
        let aiWs: WebSocket | null = null;
        let aiTimer: ReturnType<typeof setInterval> | null = null;

        const connectAi = () => {
            const wsUrl = getWsUrl();
            aiWs = new WebSocket(`${wsUrl}/ws/stream_in/${streamId}`);
            aiWs.binaryType = "arraybuffer";

            aiWs.onopen = () => {
                setIsStreaming(true);
                // AI Loop: ~10 FPS (100ms) for low latency, optimized so main thread doesn't lag
                aiTimer = setInterval(async () => {
                    if (!aiWs || aiWs.readyState !== WebSocket.OPEN) return;
                    if (!videoRef.current || videoRef.current.readyState < 2) return;

                    const vw = videoRef.current.videoWidth;
                    const vh = videoRef.current.videoHeight;
                    if (!vw || !vh) return;

                    try {
                        const targetWidth = 480;
                        const targetHeight = Math.round((480 / vw) * vh);

                        // Use OffscreenCanvas and createImageBitmap for performance if available
                        if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined") {
                            const offCanvas = new OffscreenCanvas(targetWidth, targetHeight);
                            const offCtx = offCanvas.getContext("2d");
                            if (offCtx) {
                                const bitmap = await createImageBitmap(videoRef.current!);
                                offCtx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
                                bitmap.close();
                                const blob = await offCanvas.convertToBlob({ type: "image/jpeg", quality: 0.45 });
                                if (blob && aiWs.readyState === WebSocket.OPEN) aiWs.send(blob);
                            }
                        } else {
                            const canvas = document.createElement("canvas");
                            canvas.width = targetWidth; canvas.height = targetHeight;
                            canvas.getContext("2d")!.drawImage(videoRef.current!, 0, 0, targetWidth, targetHeight);
                            const blob = await new Promise<Blob | null>(r => canvas.toBlob(b => r(b), "image/jpeg", 0.45));
                            if (blob && aiWs.readyState === WebSocket.OPEN) aiWs.send(blob);
                        }
                    } catch (e) { console.error("[useAiInference]", e); }
                }, 100);
            };

            aiWs.onclose = () => {
                if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
                if (alive) setTimeout(connectAi, 3000);
            };
        };
        connectAi();
        return () => {
            alive = false;
            if (aiTimer) clearInterval(aiTimer);
            aiWs?.close();
        };
    }, [enabled, streamId, videoRef, setIsStreaming]);
}

/**
 * WHIP Publisher View Component
 */
function WHIPPublisherView({ stream, setVideoLoaded, setIsStreaming, setNetState, publisherRef }: {
    stream: any; setVideoLoaded: (v: boolean) => void; setIsStreaming: (v: boolean) => void;
    setNetState: (s: string) => void; publisherRef: React.MutableRefObject<WHIPPublisher | null>;
}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    useEffect(() => {
        let alive = true;
        let publisher: WHIPPublisher | null = null;
        const start = async () => {
            setNetState("connecting_whip");
            try {
                publisher = new WHIPPublisher({
                    streamId: stream.id,
                    deviceId: stream.source && stream.source !== "local" ? stream.source : undefined,
                    onConnected: (ms) => {
                        if (!alive || !videoRef.current) return;
                        videoRef.current.srcObject = ms;
                        videoRef.current.play().catch(() => {});
                        setVideoLoaded(true); setNetState("whip_live");
                    },
                    onError: (err) => {
                        if (!alive) return;
                        console.error("[WHIP]", err); setNetState("whip_error");
                        if (alive) setTimeout(start, 5000);
                    },
                });
                publisherRef.current = publisher;
                const ms = await publisher.start();
                if (alive && videoRef.current) {
                    videoRef.current.srcObject = ms;
                    videoRef.current.play().catch(() => {});
                    setVideoLoaded(true); setIsStreaming(true); setNetState("whip_live");
                }
            } catch (err) {
                if (!alive) return;
                console.error("[WHIP] start failed:", err); setNetState("whip_error");
                if (alive) setTimeout(start, 5000);
            }
        };
        start();
        return () => { alive = false; publisher?.stop(); publisherRef.current = null; };
    }, [stream.id, stream.source]);
    useAiInference(stream.id, true, videoRef as any, setIsStreaming);
    return <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover z-10" style={{ transform: "translateZ(0)" }} autoPlay playsInline muted={true} />;
}

/**
 * WHEP Subscriber View Component
 */
function WHEPSubscriberView({ stream, audioMuted, setVideoLoaded, setIsStreaming, setNetState }: {
    stream: any; audioMuted: boolean; setVideoLoaded: (v: boolean) => void;
    setIsStreaming: (v: boolean) => void; setNetState: (s: string) => void;
}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [showPlay, setShowPlay] = useState(false);
    useEffect(() => {
        let alive = true;
        let sub: WHEPSubscriber | null = null;
        const start = async () => {
            setNetState("connecting_whep");
            try {
                sub = new WHEPSubscriber({
                    streamId: stream.id,
                    onConnected: () => { if (alive) setNetState("whep_live"); },
                    onTrack: (ms) => {
                        if (!alive || !videoRef.current) return;
                        videoRef.current.srcObject = ms;
                        videoRef.current.muted = audioMuted;
                        videoRef.current.play().catch(() => setShowPlay(true));
                        setVideoLoaded(true); setIsStreaming(true); setNetState("whep_live");
                    },
                    onError: (err) => {
                        if (!alive) return;
                        console.error("[WHEP]", err); setNetState("whep_error");
                        if (alive) setTimeout(start, 5000);
                    },
                });
                await sub.start();
            } catch (err) {
                if (!alive) return;
                console.error("[WHEP] start failed:", err); setNetState("whep_error");
                if (alive) setTimeout(start, 5000);
            }
        };
        start();
        return () => { alive = false; sub?.stop(); };
    }, [stream.id]);
    useEffect(() => { if (videoRef.current) videoRef.current.muted = audioMuted; }, [audioMuted]);
    const handlePlay = (e: React.MouseEvent) => {
        e.stopPropagation();
        videoRef.current?.play().then(() => setShowPlay(false)).catch(console.error);
    };
    return (
        <>
            <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover z-10" style={{ transform: "translateZ(0)" }} autoPlay playsInline muted={audioMuted} />
            {showPlay && (
                <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 cursor-pointer" onClick={handlePlay}>
                    <div className="w-16 h-16 rounded-full bg-white/20 border-2 border-white flex items-center justify-center backdrop-blur-sm">
                        <Play className="w-8 h-8 text-white ml-1" fill="white" />
                    </div>
                </div>
            )}
        </>
    );
}

/**
 * Remote Participant Stream Component
 */
function RemoteStream({ audioMuted, setVideoLoaded, setIsStreaming, setNetState }: any) {
    const { meeting } = useRealtimeKitMeeting();
    const participants = useRealtimeKitSelector(m => m.participants);
    const videoRef = useRef<HTMLVideoElement>(null);
    const [showPlayButton, setShowPlayButton] = useState(false);
    useEffect(() => {
        if (!meeting || !participants) return;
        const joinedArr = participants.joined.toArray();
        const publisher = joinedArr.find((p: any) => p.videoTrack);
        if (publisher && videoRef.current) {
            const ms = new MediaStream([publisher.videoTrack!]);
            if (publisher.audioTrack) ms.addTrack(publisher.audioTrack);
            videoRef.current.srcObject = ms;
            videoRef.current.muted = audioMuted;
            videoRef.current.play().catch(() => setShowPlayButton(true));
            setVideoLoaded(true); setIsStreaming(true); setNetState("streaming_sfu");
        }
    }, [meeting, participants, audioMuted, setVideoLoaded, setIsStreaming, setNetState]);
    const handlePlay = (e: React.MouseEvent) => {
        e.stopPropagation();
        videoRef.current?.play().then(() => setShowPlayButton(false)).catch(console.error);
    };
    return (
        <>
            <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover z-10" style={{ transform: "translateZ(0)" }} autoPlay playsInline muted={audioMuted} />
            {showPlayButton && (
                <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 cursor-pointer" onClick={handlePlay}>
                    <div className="w-16 h-16 rounded-full bg-white/20 border-2 border-white flex items-center justify-center backdrop-blur-sm">
                        <Play className="w-8 h-8 text-white ml-1" fill="white" />
                    </div>
                </div>
            )}
        </>
    );
}

/**
 * Local Participant (Owner) Stream Component
 */
function LocalStream({ streamId, setVideoLoaded, setIsStreaming, setNetState }: any) {
    const { meeting } = useRealtimeKitMeeting();
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        if (!meeting) return;
        meeting.self.enableVideo().then(() => meeting.self.enableAudio()).catch(console.error);
        setNetState("streaming_sfu");
    }, [meeting, setNetState]);
    useEffect(() => {
        if (!meeting || !videoRef.current) return;
        const attach = () => {
            const track = meeting.self.videoTrack;
            if (track && videoRef.current) {
                videoRef.current.srcObject = new MediaStream([track]);
                setVideoLoaded(true); setIsStreaming(true);
            }
        };
        attach();
        meeting.self.on("videoUpdate" as any, attach);
    }, [meeting, setVideoLoaded, setIsStreaming]);
    useAiInference(streamId, true, videoRef as any, setIsStreaming);
    return <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover z-10" style={{ transform: "translateZ(0)" }} autoPlay playsInline muted={true} />;
}

export default function StreamNode({ stream, onDelete, onDetections, onSelect, onDoubleClick, isPrimary = false }: StreamNodeProps) {
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const lastDetRef = useRef<string>("");
    const lastDetectionsRaw = useRef<any[]>([]);
    const weaponSeenStartRef = useRef<number | null>(null);
    const pulsePhaseRef = useRef<number>(0);
    const rafRef = useRef<number>(0);
    const publisherRef = useRef<WHIPPublisher | null>(null);

    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [netState, setNetState] = useState("init");
    const [fallbackFrame, setFallbackFrame] = useState("");
    const [localDeviceId, setLocalDeviceId] = useState("");
    const [micEnabled, setMicEnabled] = useState(true);
    const [audioMuted, setAudioMuted] = useState(false);
    const [rtkClient, setRtkClient] = useState<any>(null);

    const isClientCam = stream.type === "client_cam";
    const hasCallsSession = !!stream.calls_session_id;
    const hasMeeting = !!stream.cf_meeting_id;

    useEffect(() => {
        let id = localStorage.getItem("device_id");
        if (!id) { id = Math.random().toString(36).substring(2, 15); localStorage.setItem("device_id", id); }
        queueMicrotask(() => setLocalDeviceId(id!));
        const animate = (time: number) => {
            pulsePhaseRef.current = (time % 1000) / 1000;
            if (lastDetectionsRaw.current.length > 0) drawDetections(lastDetectionsRaw.current);
            rafRef.current = requestAnimationFrame(animate);
        };
        rafRef.current = requestAnimationFrame(animate);
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    }, []);

    const isOwner = useMemo(
        () => isClientCam && stream.device_id === localDeviceId,
        [isClientCam, stream.device_id, localDeviceId]
    );

    // ── Detections Drawing ──
    const drawDetections = useCallback((detections: any[]) => {
        const canvas = overlayRef.current;
        if (!canvas) return;
        const dw = canvas.clientWidth || 640, dh = canvas.clientHeight || 480;
        if (canvas.width !== dw || canvas.height !== dh) { canvas.width = dw; canvas.height = dh; }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, dw, dh);
        const phase = pulsePhaseRef.current;
        const pulseOpacity = 0.4 + 0.6 * (Math.sin(phase * Math.PI * 2) * 0.5 + 0.5);
        const hasWeapon = detections.some(d => (d.detection_type === "weapon" || d.class_name === "gun" || d.class_name === "weapon") && d.confidence >= 0.45);
        if (hasWeapon) { if (weaponSeenStartRef.current === null) weaponSeenStartRef.current = Date.now(); }
        else { weaponSeenStartRef.current = null; }
        const isPersistentWeapon = weaponSeenStartRef.current !== null && (Date.now() - weaponSeenStartRef.current) > 1000;
        detections.forEach((det: any) => {
            const detType = det.detection_type ?? "";
            const isWeapon = detType === "weapon" || det.class_name === "gun" || det.class_name === "weapon";
            const isPerson = det.class_name === "person";
            if (det.confidence < (isPerson ? 0.25 : 0.45)) return;
            const b = det.bbox;
            const x1 = (b.x1 ?? b[0]) * dw, y1 = (b.y1 ?? b[1]) * dh;
            const x2 = (b.x2 ?? b[2]) * dw, y2 = (b.y2 ?? b[3]) * dh;
            const width = x2 - x1, height = y2 - y1;
            if (isWeapon && isPersistentWeapon) {
                const baseColor = `rgba(255,51,0,${pulseOpacity})`;
                for (let i = 1; i <= 3; i++) {
                    const o = i * 4; ctx.lineWidth = 1;
                    ctx.strokeStyle = `rgba(255,51,0,${pulseOpacity * (0.3 / i)})`;
                    ctx.strokeRect(x1 - o, y1 - o, width + o * 2, height + o * 2);
                }
                ctx.strokeStyle = baseColor; ctx.lineWidth = 4;
                ctx.strokeRect(x1, y1, width, height);
                ctx.fillStyle = `rgba(255,51,0,${pulseOpacity * 0.2})`; ctx.fillRect(x1, y1, width, height);
                ctx.strokeStyle = baseColor; ctx.lineWidth = 1; ctx.beginPath();
                ctx.moveTo(x1 + width / 2 - 10, y1 + height / 2); ctx.lineTo(x1 + width / 2 + 10, y1 + height / 2);
                ctx.moveTo(x1 + width / 2, y1 + height / 2 - 10); ctx.lineTo(x1 + width / 2, y1 + height / 2 + 10); ctx.stroke();
                const label = `${(det.class_name || "WEAPON").toUpperCase()} ${(det.confidence * 100).toFixed(0)}%`;
                ctx.font = "bold 14px Inter,sans-serif";
                const tw = ctx.measureText(label).width;
                ctx.fillStyle = "#FF3300"; ctx.fillRect(x1, y1 - 22, tw + 12, 22);
                ctx.fillStyle = "white"; ctx.fillText(label, x1 + 6, y1 - 6);
            } else {
                let color = "rgba(200,200,200,0.5)";
                if (detType === "violent_person") color = "rgba(204,51,255,0.7)";
                else if (detType === "fall") color = "rgba(255,153,0,0.7)";
                else if (det.class_name === "knife" || detType === "knife") color = "rgba(255,255,0,0.8)";
                ctx.strokeStyle = color; ctx.lineWidth = 1.5;
                ctx.strokeRect(x1, y1, width, height);
                ctx.fillStyle = color.replace("0.5","0.05").replace("0.7","0.07").replace("0.8","0.1");
                ctx.fillRect(x1, y1, width, height);
            }
        });
    }, []);

    // ── Detection WebSocket ──
    useEffect(() => {
        let alive = true;
        const wsUrl = getWsUrl();
        let detWs: WebSocket | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;
        const connect = () => {
            if (!alive) return;
            const wsPath = isClientCam ? `${wsUrl}/ws/detections/${stream.id}` : `${wsUrl}/ws/stream_out/${stream.id}`;
            detWs = new WebSocket(wsPath);
            detWs.onopen = () => {
                pingTimer = setInterval(() => { if (detWs?.readyState === WebSocket.OPEN) detWs.send("ping"); }, 25000);
            };
            detWs.onmessage = (evt) => {
                try {
                    const data = JSON.parse(evt.data);
                    if (data.type === "frame" && data.frame && !isClientCam) {
                        setFallbackFrame(`data:image/jpeg;base64,${data.frame}`);
                        setVideoLoaded(true); setIsStreaming(true);
                    }
                    if (data.detections) {
                        const key = JSON.stringify(data.detections.map((d: any) => d.class_name + d.confidence.toFixed(2)));
                        if (key !== lastDetRef.current) {
                            lastDetRef.current = key;
                            lastDetectionsRaw.current = data.detections;
                            drawDetections(data.detections);
                            onDetections(data.detections, data.timestamp);
                        }
                    }
                } catch { /* ignore */ }
            };
            detWs.onclose = () => {
                if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
                if (alive) setTimeout(connect, 3000);
            };
        };
        connect();
        return () => { alive = false; if (pingTimer) clearInterval(pingTimer); detWs?.close(); };
    }, [stream.id, isClientCam, drawDetections, onDetections]);

    // ── Realtime Kit Session ──
    useEffect(() => {
        if (hasCallsSession || !hasMeeting || !isClientCam || !localDeviceId) return;
        let alive = true;
        let session: RealtimeSession | null = null;
        const init = async () => {
            try {
                setNetState("connecting_sfu");
                session = await joinMeeting(stream.id, isOwner ? (stream.name || "Publisher") : "Viewer", localDeviceId);
                if (!alive) { session.stop(); return; }
                setRtkClient(session.meeting);
            } catch (err) {
                console.error("[RTK] init failed:", err); setNetState("sfu_error");
                if (alive) setTimeout(init, 5000);
            }
        };
        init();
        return () => { alive = false; session?.stop(); };
    }, [hasCallsSession, hasMeeting, isClientCam, stream.id, stream.name, localDeviceId, isOwner]);

    const toggleMic = (e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !micEnabled; setMicEnabled(next);
        publisherRef.current?.toggleMic(next);
        if (rtkClient?.self) { if (next) rtkClient.self.enableAudio(); else rtkClient.self.disableAudio(); }
    };
    const toggleAudio = (e: React.MouseEvent) => { e.stopPropagation(); setAudioMuted(!audioMuted); };
    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (window.confirm(`Terminate ${stream.name}?`)) onDelete(stream.id, true);
    };

    const techLabel = hasCallsSession ? "⚡WHIP" : hasMeeting ? "⚡RTK" : "";

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 35, mass: 0.6 }}
            onClick={() => onSelect?.()}
            onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(); }}
            className={`relative w-full h-full flex-1 min-h-0 bg-[#0A0A0A] flex flex-col group cursor-pointer origin-center border-[2px] overflow-hidden ${isPrimary ? "border-[var(--color-data)]" : "border-[var(--color-dim)] hover:border-[var(--color-iron)]"}`}
        >
            {/* Header */}
            <div className="p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 w-full">
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[180px] whitespace-nowrap`}>
                    {stream.name} [{stream.type.toUpperCase()}]{techLabel && ` ${techLabel}`}
                </span>
                <div className="flex gap-1">
                    {isOwner && isClientCam && (
                        <button onClick={toggleMic} title={micEnabled ? "Mute mic" : "Unmute mic"} className="bg-black text-[var(--color-silica)] hover:text-white border border-[var(--color-iron)] px-1">
                            {micEnabled ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3 text-red-500" />}
                        </button>
                    )}
                    {!isOwner && isClientCam && (hasCallsSession || hasMeeting) && (
                        <button onClick={toggleAudio} title={audioMuted ? "Unmute" : "Mute"} className="bg-black text-[var(--color-silica)] hover:text-white border border-[var(--color-iron)] px-1">
                            {audioMuted ? <VolumeX className="w-3 h-3 text-red-500" /> : <Volume2 className="w-3 h-3" />}
                        </button>
                    )}
                    {isClientCam && (
                        <span className={`bg-black px-1 border border-[var(--color-iron)] flex items-center ${isStreaming ? "text-[var(--color-data)]" : "text-[#555]"}`}>
                            {isStreaming ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                        </span>
                    )}
                    <span className={`bg-black px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] ${isStreaming ? "text-[var(--color-alert)] animate-pulse" : "text-[#333]"}`}>
                        {isStreaming ? "LIVE" : "..."}
                    </span>
                    <button onClick={handleDelete} className="bg-black text-[var(--color-iron)] hover:text-red-500 hover:border-red-500 border border-[var(--color-iron)] px-1">
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {/* Video / Fallback */}
            <div className="relative flex-1 w-full h-full flex items-center justify-center overflow-hidden">
                {!videoLoaded && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0d0d0d] z-30">
                        <div className="flex gap-1 mb-4">
                            {[0, 1, 2].map((i) => (
                                <motion.div key={i} animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }} className="w-8 h-8 bg-[var(--color-iron)]" />
                            ))}
                        </div>
                        <div className="text-[10px] font-bold tracking-[0.2em] text-[var(--color-data)] whitespace-nowrap">
                            [{netState.replace(/_/g, " ").toUpperCase()}]
                        </div>
                    </div>
                )}

                {isClientCam && hasCallsSession && localDeviceId && (
                    isOwner ? (
                        <WHIPPublisherView stream={stream} setVideoLoaded={setVideoLoaded} setIsStreaming={setIsStreaming} setNetState={setNetState} publisherRef={publisherRef} />
                    ) : (
                        <WHEPSubscriberView stream={stream} audioMuted={audioMuted} setVideoLoaded={setVideoLoaded} setIsStreaming={setIsStreaming} setNetState={setNetState} />
                    )
                )}

                {isClientCam && !hasCallsSession && rtkClient && (
                    <RealtimeKitProvider value={rtkClient}>
                        {isOwner ? (
                            <LocalStream streamId={stream.id} setVideoLoaded={setVideoLoaded} setIsStreaming={setIsStreaming} setNetState={setNetState} />
                        ) : (
                            <RemoteStream audioMuted={audioMuted} setVideoLoaded={setVideoLoaded} setIsStreaming={setIsStreaming} setNetState={setNetState} />
                        )}
                    </RealtimeKitProvider>
                )}

                {!isClientCam && fallbackFrame && (
                    <img src={fallbackFrame} alt="Stream" className="absolute inset-0 h-full w-full object-cover z-10" onLoad={() => setVideoLoaded(true)} />
                )}

                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />
            </div>
        </motion.div>
    );
}
