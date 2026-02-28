"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Play, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";
import { joinMeeting, type RealtimeSession } from "@/lib/cloudflare-calls";

interface StreamNodeProps {
    stream: any;
    onDelete: (id: string, cascadeDelete: boolean) => void;
    onDetections: (detections: any[], timestamp: number) => void;
    onSelect?: () => void;
    onDoubleClick?: () => void;
    isPrimary?: boolean;
}

export default function StreamNode({ stream, onDelete, onDetections, onSelect, onDoubleClick, isPrimary = false }: StreamNodeProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const lastDetRef = useRef<string>("");

    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [showPlayButton, setShowPlayButton] = useState(false);
    const [netState, setNetState] = useState("init");
    const [fallbackFrame, setFallbackFrame] = useState("");
    const [localDeviceId, setLocalDeviceId] = useState("");
    const [micEnabled, setMicEnabled] = useState(true);
    const [audioMuted, setAudioMuted] = useState(false);

    const isClientCam = stream.type === "client_cam";
    const isOwner = isClientCam && stream.device_id === localDeviceId;
    const hasMeeting = !!stream.cf_meeting_id;

    // ── Device ID ──
    useEffect(() => {
        let id = localStorage.getItem("device_id");
        if (!id) {
            id = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", id);
        }
        queueMicrotask(() => setLocalDeviceId(id!));
    }, []);

    // ── Draw detection overlays (throttled via ref) ──
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
            const isWeapon = ["rifle", "handgun", "knife", "weapon", "violence"].includes(det.class_name);
            const color = isWeapon ? "#FF3300" : "#FFFFFF";
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
                        // Throttle: skip if identical to last
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

    // ── Realtime Kit: Camera owner publishes via SDK + sends frames for AI ──
    useEffect(() => {
        if (!isClientCam || !isOwner) return;

        let alive = true;
        let session: RealtimeSession | null = null;
        let aiWs: WebSocket | null = null;
        let aiTimer: ReturnType<typeof setInterval> | null = null;

        const start = async () => {
            try {
                setNetState("starting_camera");
                const media = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
                    audio: true,
                });
                if (!alive) { media.getTracks().forEach(t => t.stop()); return; }

                localStreamRef.current = media;
                if (videoRef.current) {
                    videoRef.current.srcObject = media;
                    videoRef.current.muted = true;
                    await videoRef.current.play().catch(() => undefined);
                    setVideoLoaded(true);
                }

                // Publish via Realtime Kit SDK
                if (hasMeeting) {
                    setNetState("connecting_sfu");
                    try {
                        session = await joinMeeting(stream.id, stream.name || "Publisher", localDeviceId);
                        await session.meeting.self.enableVideo();
                        await session.meeting.self.enableAudio();
                        setNetState("streaming_sfu");
                    } catch (err) {
                        console.error("[RTK] publish failed, falling back to WS:", err);
                        session = null;
                    }
                }

                // Send frames to backend for AI at ~5 FPS (200ms) to reduce lag
                setNetState(session ? "streaming_sfu" : "connecting_ws");
                const wsUrl = getWsUrl();
                aiWs = new WebSocket(`${wsUrl}/ws/stream_in/${stream.id}`);
                aiWs.binaryType = "arraybuffer";

                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d")!;
                let sending = false;

                aiWs.onopen = () => {
                    setIsStreaming(true);
                    if (!session) setNetState("streaming");
                    aiTimer = setInterval(async () => {
                        if (sending || !videoRef.current || !aiWs || aiWs.readyState !== WebSocket.OPEN) return;
                        if (videoRef.current.readyState < 2) return;
                        const vw = videoRef.current.videoWidth;
                        const vh = videoRef.current.videoHeight;
                        if (!vw || !vh) return;
                        sending = true;
                        canvas.width = 480;
                        canvas.height = Math.round((480 / vw) * vh);
                        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                        const blob = await new Promise<Blob | null>(r =>
                            canvas.toBlob(b => r(b), "image/jpeg", 0.45),
                        );
                        if (blob && aiWs?.readyState === WebSocket.OPEN) aiWs.send(blob);
                        sending = false;
                    }, 200); // 5 FPS for AI — much less bandwidth
                };
                aiWs.onclose = () => {
                    if (!session) setNetState("reconnecting");
                    if (alive && !session) setTimeout(start, 3000);
                };
            } catch (err) {
                console.error("[StreamNode] start failed:", err);
                setNetState("provider_error");
                if (alive) setTimeout(start, 5000);
            }
        };

        start();
        return () => {
            alive = false;
            if (aiTimer) clearInterval(aiTimer);
            aiWs?.close();
            session?.stop();
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(t => t.stop());
                localStreamRef.current = null;
            }
        };
    }, [isClientCam, isOwner, hasMeeting, stream.id, stream.name, localDeviceId]);

    // ── Realtime Kit: Viewer subscribes via SDK ──
    useEffect(() => {
        if (isOwner || !hasMeeting || !isClientCam) return;

        let alive = true;
        let session: RealtimeSession | null = null;

        const start = async () => {
            try {
                setNetState("connecting_sfu");
                session = await joinMeeting(stream.id, "Viewer", localDeviceId);
                if (!alive) { session.stop(); return; }

                // Listen for remote participant video
                const meeting = session.meeting;
                const attachRemote = () => {
                    const joined = meeting.participants.joined;
                    if (joined && typeof joined.toArray === "function") {
                        const remotes = joined.toArray();
                        for (const p of remotes) {
                            const videoTrack = p.videoTrack;
                            if (videoTrack && videoRef.current) {
                                const ms = new MediaStream([videoTrack]);
                                const audioTrack = p.audioTrack;
                                if (audioTrack) ms.addTrack(audioTrack);
                                videoRef.current.srcObject = ms;
                                videoRef.current.muted = audioMuted;
                                videoRef.current.play().catch(() => setShowPlayButton(true));
                                setVideoLoaded(true);
                                setIsStreaming(true);
                                setNetState("streaming_sfu");
                                return;
                            }
                        }
                    }
                };

                // Try immediately, then listen for updates
                attachRemote();
                meeting.participants.joined.on?.("participantJoined" as any, attachRemote);
                meeting.participants.joined.on?.("videoUpdate" as any, attachRemote);
                meeting.participants.joined.on?.("audioUpdate" as any, attachRemote);

                // Also poll briefly in case events don't fire
                const poll = setInterval(() => {
                    if (!alive) { clearInterval(poll); return; }
                    attachRemote();
                }, 2000);
                setTimeout(() => clearInterval(poll), 30000);

            } catch (err) {
                console.error("[RTK] view failed:", err);
                setNetState("sfu_error");
                if (alive) setTimeout(start, 5000);
            }
        };

        start();
        return () => { alive = false; session?.stop(); };
    }, [isOwner, hasMeeting, isClientCam, stream.id, localDeviceId, audioMuted]);

    // ── Mic toggle (owner only) ──
    const toggleMic = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!localStreamRef.current) return;
        const audioTracks = localStreamRef.current.getAudioTracks();
        const next = !micEnabled;
        audioTracks.forEach(t => { t.enabled = next; });
        setMicEnabled(next);
    };

    // ── Audio toggle (viewer) ──
    const toggleAudio = (e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !audioMuted;
        setAudioMuted(next);
        if (videoRef.current) videoRef.current.muted = next;
    };

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (window.confirm(`Terminate ${stream.name}?`)) onDelete(stream.id, true);
    };

    const handleClick = (e: React.MouseEvent) => {
        // Double-click handled by onDoubleClick prop
        if (e.detail === 1 && onSelect) onSelect();
    };

    const useVideoElement = isOwner || (hasMeeting && isClientCam);

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 35, mass: 0.6 }}
            onClick={handleClick}
            onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(); }}
            className={`relative w-full h-full flex-1 min-h-0 bg-[#0A0A0A] flex flex-col group cursor-pointer origin-center border-[2px] overflow-hidden ${isPrimary ? "border-[var(--color-data)]" : "border-[var(--color-dim)] hover:border-[var(--color-iron)]"}`}
        >
            {/* Header */}
            <div className="p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 w-full">
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[180px]`}>
                    {stream.name} [{stream.type.toUpperCase()}]{hasMeeting ? " ⚡LIVE" : ""}
                </span>
                <div className="flex gap-1">
                    {/* Audio controls */}
                    {isOwner && (
                        <button onClick={toggleMic} className="bg-black text-[var(--color-silica)] hover:text-white border border-[var(--color-iron)] px-1" title={micEnabled ? "Mute mic" : "Unmute mic"}>
                            {micEnabled ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3 text-red-500" />}
                        </button>
                    )}
                    {!isOwner && useVideoElement && (
                        <button onClick={toggleAudio} className="bg-black text-[var(--color-silica)] hover:text-white border border-[var(--color-iron)] px-1" title={audioMuted ? "Unmute" : "Mute"}>
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

                {useVideoElement ? (
                    <video
                        ref={videoRef}
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        style={{ transform: "translateZ(0)" }}
                        autoPlay playsInline
                        muted={isOwner || audioMuted}
                    />
                ) : (
                    fallbackFrame && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={fallbackFrame} alt="Stream" className="absolute inset-0 h-full w-full object-cover z-10" onLoad={() => setVideoLoaded(true)} />
                    )
                )}

                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />

                {showPlayButton && (
                    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 cursor-pointer" onClick={(e) => { e.stopPropagation(); setShowPlayButton(false); videoRef.current?.play().catch(() => undefined); }}>
                        <div className="w-16 h-16 rounded-full bg-white/20 border-2 border-white flex items-center justify-center backdrop-blur-sm">
                            <Play className="w-8 h-8 text-white ml-1" fill="white" />
                        </div>
                    </div>
                )}
            </div>
        </motion.div>
    );
}
