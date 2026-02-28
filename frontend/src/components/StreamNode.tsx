"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Trash2, Play, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";
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

            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d")!;
            let sending = false;

            aiWs.onopen = () => {
                setIsStreaming(true);
                // AI Loop: ~10 FPS (100ms) for low latency, optimized so main thread doesn't lag
                aiTimer = setInterval(async () => {
                    if (sending || !aiWs || aiWs.readyState !== WebSocket.OPEN) return;
                    if (!videoRef.current || videoRef.current.readyState < 2) return;
                    
                    const vw = videoRef.current.videoWidth;
                    const vh = videoRef.current.videoHeight;
                    if (!vw || !vh) return;
                    
                    sending = true;
                    try {
                        const targetWidth = 480;
                        const targetHeight = Math.round((480 / vw) * vh);
                        
                        // Use OffscreenCanvas and createImageBitmap for performance if available
                        if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined") {
                            const offCanvas = new OffscreenCanvas(targetWidth, targetHeight);
                            const offCtx = offCanvas.getContext("2d");
                            if (offCtx) {
                                const bitmap = await createImageBitmap(videoRef.current);
                                offCtx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
                                bitmap.close();
                                const blob = await offCanvas.convertToBlob({ type: "image/jpeg", quality: 0.45 });
                                if (blob && aiWs.readyState === WebSocket.OPEN) aiWs.send(blob);
                            }
                        } else {
                            canvas.width = targetWidth;
                            canvas.height = targetHeight;
                            ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                            const blob = await new Promise<Blob | null>(r =>
                                canvas.toBlob(b => r(b), "image/jpeg", 0.45)
                            );
                            if (blob && aiWs.readyState === WebSocket.OPEN) aiWs.send(blob);
                        }
                    } catch (e) {
                        console.error("[useAiInference] Frame capture error:", e);
                    } finally {
                        sending = false;
                    }
                }, 100); 
            };

            aiWs.onclose = () => {
                if (aiTimer) clearInterval(aiTimer);
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
 * Remote Participant Stream Component
 */
function RemoteStream({ audioMuted, setVideoLoaded, setIsStreaming, setNetState }: any) {
    const { meeting } = useRealtimeKitMeeting();
    const participants = useRealtimeKitSelector(m => m.participants);
    const videoRef = useRef<HTMLVideoElement>(null);
    const [showPlayButton, setShowPlayButton] = useState(false);

    useEffect(() => {
        if (!meeting || !participants) return;

        // Find the first participant who is publishing video
        const joinedArr = participants.joined.toArray();
        const publisher = joinedArr.find((p: any) => p.videoTrack);
        
        if (publisher && videoRef.current) {
            const videoTrack = publisher.videoTrack!;
            const audioTrack = publisher.audioTrack;
            
            const ms = new MediaStream([videoTrack]);
            if (audioTrack) ms.addTrack(audioTrack);
            
            videoRef.current.srcObject = ms;
            videoRef.current.muted = audioMuted;
            videoRef.current.play().catch(() => setShowPlayButton(true));
            
            setVideoLoaded(true);
            setIsStreaming(true);
            setNetState("streaming_sfu");
        }
    }, [meeting, participants, audioMuted, setVideoLoaded, setIsStreaming, setNetState]);

    const handlePlay = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (videoRef.current) {
            videoRef.current.play().then(() => setShowPlayButton(false)).catch(console.error);
        }
    };

    return (
        <>
            <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-cover z-10"
                style={{ transform: "translateZ(0)" }}
                autoPlay playsInline
                muted={audioMuted}
            />
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

    // 1. Enable media
    useEffect(() => {
        if (!meeting) return;
        const start = async () => {
            try {
                await meeting.self.enableVideo();
                await meeting.self.enableAudio();
                setNetState("streaming_sfu");
            } catch (err) {
                console.error("[RTK] local start failed:", err);
            }
        };
        start();
    }, [meeting, setNetState]);

    // 2. Attach local track to preview
    useEffect(() => {
        if (!meeting || !videoRef.current) return;
        const attach = () => {
            const track = meeting.self.videoTrack;
            if (track && videoRef.current) {
                videoRef.current.srcObject = new MediaStream([track]);
                setVideoLoaded(true);
                setIsStreaming(true);
            }
        };
        attach();
        meeting.self.on("videoUpdate" as any, attach);
    }, [meeting, setVideoLoaded, setIsStreaming]);

    // 3. AI Inference Loop (Owner side)
    useAiInference(streamId, true, videoRef, setIsStreaming);

    return (
        <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-cover z-10"
            style={{ transform: "translateZ(0)" }}
            autoPlay playsInline
            muted={true}
        />
    );
}

export default function StreamNode({ stream, onDelete, onDetections, onSelect, onDoubleClick, isPrimary = false }: StreamNodeProps) {
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const lastDetRef = useRef<string>("");

    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [netState, setNetState] = useState("init");
    const [fallbackFrame, setFallbackFrame] = useState("");
    const [localDeviceId, setLocalDeviceId] = useState("");
    const [micEnabled, setMicEnabled] = useState(true);
    const [audioMuted, setAudioMuted] = useState(false);
    const [rtkClient, setRtkClient] = useState<any>(null);

    const isClientCam = stream.type === "client_cam";
    const hasMeeting = !!stream.cf_meeting_id;

    useEffect(() => {
        let id = localStorage.getItem("device_id");
        if (!id) {
            id = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", id);
        }
        setLocalDeviceId(id);
    }, []);

    const isOwner = useMemo(() => isClientCam && stream.device_id === localDeviceId, [isClientCam, stream.device_id, localDeviceId]);

    // ── Detections Drawing ──
    const drawDetections = useCallback((detections: any[]) => {
        const canvas = overlayRef.current;
        if (!canvas) return;
        const dw = canvas.clientWidth || 640;
        const dh = canvas.clientHeight || 480;
        if (canvas.width !== dw || canvas.height !== dh) {
            canvas.width = dw;
            canvas.height = dh;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, dw, dh);

        const scale = Math.max(dw / 1280, 0.4);
        detections.forEach((det: any) => {
            if (det.confidence < 0.45) return;
            const b = det.bbox;
            const x1 = (b.x1 ?? b[0]) * dw;
            const y1 = (b.y1 ?? b[1]) * dh;
            const x2 = (b.x2 ?? b[2]) * dw;
            const y2 = (b.y2 ?? b[3]) * dh;
            const detType = det.detection_type ?? "";
            const isKnife = det.class_name === "knife" || detType === "knife";
            const isThreat = det.is_threat
                || detType === "weapon"
                || detType === "fall"
                || detType === "violent_person"
                || det.class_name === "gun"
                || det.class_name === "weapon";

            let color = "#FFFFFF"; 
            if (detType === "violent_person") color = "#CC33FF"; 
            else if (detType === "fall") color = "#FF9900"; 
            else if (isThreat) color = "#FF3300"; 
            else if (isKnife) color = "#FFFF00"; 

            const corner = Math.max(6, 10 * scale);
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(2, 2 * scale);
            ctx.beginPath();
            ctx.moveTo(x1, y1 + corner); ctx.lineTo(x1, y1); ctx.lineTo(x1 + corner, y1);
            ctx.moveTo(x2 - corner, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + corner);
            ctx.moveTo(x2, y2 - corner); ctx.lineTo(x2, y2); ctx.lineTo(x2 - corner, y2);
            ctx.moveTo(x1 + corner, y2); ctx.lineTo(x1, y2); ctx.lineTo(x1, y2 - corner);
            ctx.stroke();
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
            const wsPath = hasMeeting
                ? `${wsUrl}/ws/detections/${stream.id}`
                : `${wsUrl}/ws/stream_out/${stream.id}`;
            detWs = new WebSocket(wsPath);
            detWs.onopen = () => {
                pingTimer = setInterval(() => {
                    if (detWs?.readyState === WebSocket.OPEN) detWs.send("ping");
                }, 25000);
            };
            detWs.onmessage = (evt) => {
                try {
                    const data = JSON.parse(evt.data);
                    if (data.type === "frame" && data.frame && !hasMeeting) {
                        setFallbackFrame(`data:image/jpeg;base64,${data.frame}`);
                        setVideoLoaded(true);
                        setIsStreaming(true);
                    }
                    if (data.detections) {
                        const key = JSON.stringify(data.detections.map((d: any) => d.class_name + d.confidence.toFixed(2)));
                        if (key !== lastDetRef.current) {
                            lastDetRef.current = key;
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
    }, [stream.id, hasMeeting, drawDetections, onDetections]);

    // ── Realtime Kit Session ──
    useEffect(() => {
        if (!hasMeeting || !isClientCam || !localDeviceId) return;
        let alive = true;
        let session: RealtimeSession | null = null;
        const init = async () => {
            try {
                setNetState("connecting_sfu");
                session = await joinMeeting(stream.id, isOwner ? (stream.name || "Publisher") : "Viewer", localDeviceId);
                if (!alive) { session.stop(); return; }
                setRtkClient(session.meeting);
            } catch (err) {
                console.error("[RTK] init failed:", err);
                setNetState("sfu_error");
                if (alive) setTimeout(init, 5000);
            }
        };
        init();
        return () => { alive = false; session?.stop(); };
    }, [hasMeeting, isClientCam, stream.id, stream.name, localDeviceId, isOwner]);

    const toggleMic = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (rtkClient?.self) {
            const next = !micEnabled;
            if (next) rtkClient.self.enableAudio();
            else rtkClient.self.disableAudio();
            setMicEnabled(next);
        }
    };

    const toggleAudio = (e: React.MouseEvent) => {
        e.stopPropagation();
        setAudioMuted(!audioMuted);
    };

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (window.confirm(`Terminate ${stream.name}?`)) onDelete(stream.id, true);
    };

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
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[180px]`}>
                    {stream.name} [{stream.type.toUpperCase()}]{hasMeeting ? " ⚡LIVE" : ""}
                </span>
                <div className="flex gap-1">
                    {isOwner && (
                        <button onClick={toggleMic} className="bg-black text-[var(--color-silica)] hover:text-white border border-[var(--color-iron)] px-1">
                            {micEnabled ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3 text-red-500" />}
                        </button>
                    )}
                    {!isOwner && isClientCam && hasMeeting && (
                        <button onClick={toggleAudio} className="bg-black text-[var(--color-silica)] hover:text-white border border-[var(--color-iron)] px-1">
                            {audioMuted ? <VolumeX className="w-3 h-3 text-red-500" /> : <Volume2 className="w-3 h-3" />}
                        </button>
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
                        <div className="text-[10px] font-bold tracking-[0.2em] text-[var(--color-data)]">
                            [{netState.replace(/_/g, " ").toUpperCase()}]
                        </div>
                    </div>
                )}

                {rtkClient ? (
                    <RealtimeKitProvider value={rtkClient}>
                        {isOwner ? (
                            <LocalStream 
                                streamId={stream.id}
                                setVideoLoaded={setVideoLoaded} 
                                setIsStreaming={setIsStreaming} 
                                setNetState={setNetState}
                            />
                        ) : (
                            <RemoteStream
                                audioMuted={audioMuted}
                                setVideoLoaded={setVideoLoaded} 
                                setIsStreaming={setIsStreaming} 
                                setNetState={setNetState}
                            />
                        )}
                    </RealtimeKitProvider>
                ) : (
                    fallbackFrame && (
                        <img src={fallbackFrame} alt="Stream" className="absolute inset-0 h-full w-full object-cover z-10" onLoad={() => setVideoLoaded(true)} />
                    )
                )}

                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />
            </div>
        </motion.div>
    );
}
