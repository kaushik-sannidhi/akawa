"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Play } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";

interface StreamNodeProps {
    stream: any;
    onDelete: (id: string, cascadeDelete: boolean) => void;
    onDetections: (detections: any[], timestamp: number) => void;
    onSelect?: () => void;
    isPrimary?: boolean;
}

export default function StreamNode({ stream, onDelete, onDetections, onSelect, isPrimary = false }: StreamNodeProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const localStreamRef = useRef<MediaStream | null>(null);

    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [showPlayButton, setShowPlayButton] = useState(false);
    const [netState, setNetState] = useState("init");
    const [fallbackFrame, setFallbackFrame] = useState("");
    const [localDeviceId, setLocalDeviceId] = useState("");

    const isClientCam = stream.type === "client_cam";
    const isOwner = isClientCam && stream.device_id === localDeviceId;

    useEffect(() => {
        let id = localStorage.getItem("device_id");
        if (!id) {
            id = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", id);
        }
        setLocalDeviceId(id);
    }, []);

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
            const isWeapon = ["rifle", "handgun", "knife", "weapon"].includes(det.class_name);
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

    // ============ Detection + frame viewer WebSocket (all roles) ============
    useEffect(() => {
        let alive = true;
        const wsUrl = getWsUrl();
        let detWs: WebSocket | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const connect = () => {
            if (!alive) return;
            detWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
            detWs.onopen = () => {
                pingTimer = setInterval(() => {
                    if (detWs?.readyState === WebSocket.OPEN) detWs.send("ping");
                }, 15000);
            };
            detWs.onmessage = (evt) => {
                try {
                    const data = JSON.parse(evt.data);
                    if (data.type === "frame" && data.frame) {
                        setFallbackFrame(`data:image/jpeg;base64,${data.frame}`);
                        setVideoLoaded(true);
                        setIsStreaming(true);
                    }
                    if (data.detections) {
                        drawDetections(data.detections);
                        onDetections(data.detections, data.timestamp);
                    }
                } catch {
                    // ignore malformed messages
                }
            };
            detWs.onclose = () => {
                if (pingTimer) {
                    clearInterval(pingTimer);
                    pingTimer = null;
                }
                if (alive) setTimeout(connect, 3000);
            };
        };

        connect();
        return () => {
            alive = false;
            if (pingTimer) clearInterval(pingTimer);
            if (detWs) detWs.close();
        };
    }, [stream.id, drawDetections, onDetections]);

    // ============ Camera provider: capture & send frames via WebSocket ============
    useEffect(() => {
        if (!isClientCam || !isOwner) return;

        let alive = true;
        let aiWs: WebSocket | null = null;
        let aiTimer: ReturnType<typeof setInterval> | null = null;

        const start = async () => {
            try {
                setNetState("starting_camera");
                const media = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
                    audio: false,
                });
                if (!alive) {
                    media.getTracks().forEach((t) => t.stop());
                    return;
                }

                localStreamRef.current = media;
                if (videoRef.current) {
                    videoRef.current.srcObject = media;
                    videoRef.current.muted = true;
                    await videoRef.current.play().catch(() => undefined);
                    setVideoLoaded(true);
                }

                setNetState("connecting_ws");
                const wsUrl = getWsUrl();
                aiWs = new WebSocket(`${wsUrl}/ws/stream_in/${stream.id}`);
                aiWs.binaryType = "arraybuffer";
                aiWs.onopen = () => {
                    setIsStreaming(true);
                    setNetState("streaming");
                    const canvas = document.createElement("canvas");
                    const ctx = canvas.getContext("2d");
                    aiTimer = setInterval(async () => {
                        if (!videoRef.current || !ctx || !aiWs || aiWs.readyState !== WebSocket.OPEN) return;
                        if (videoRef.current.readyState < 2) return;
                        const vw = videoRef.current.videoWidth;
                        const vh = videoRef.current.videoHeight;
                        if (!vw || !vh) return;
                        canvas.width = 640;
                        canvas.height = Math.round((640 / vw) * vh);
                        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                        const blob = await new Promise<Blob | null>((resolve) =>
                            canvas.toBlob((b) => resolve(b), "image/jpeg", 0.55),
                        );
                        if (blob) aiWs.send(blob);
                    }, 100); // ~10 FPS
                };
                aiWs.onclose = () => {
                    setNetState("reconnecting");
                    if (alive) setTimeout(start, 3000);
                };
                aiWs.onerror = () => {
                    setNetState("provider_error");
                };
            } catch (err) {
                console.error("[WS Provider] start failed:", err);
                setNetState("provider_error");
            }
        };

        start();
        return () => {
            alive = false;
            if (aiTimer) clearInterval(aiTimer);
            if (aiWs) aiWs.close();
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach((t) => t.stop());
                localStreamRef.current = null;
            }
        };
    }, [isClientCam, isOwner, stream.id]);

    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const ok = window.confirm(`Terminate ${stream.name}?`);
        if (!ok) return;
        onDelete(stream.id, true);
    };

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.8 }}
            onClick={onSelect}
            className={`relative w-full h-full flex-1 min-h-[240px] bg-[#0A0A0A] flex flex-col group cursor-pointer origin-center ${isPrimary ? "sm:col-span-2 sm:row-span-2 border-[2px] border-[var(--color-iron)]" : "border-[2px] border-[var(--color-dim)] overflow-hidden hover:border-[var(--color-data)]"}`}
        >
            {isPrimary && <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:32px_32px] opacity-10 pointer-events-none z-0" />}

            <div className={`p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent ${!isPrimary ? "bg-black border-b-[2px] border-[var(--color-iron)]" : ""} absolute top-0 left-0 w-full`}>
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[180px]`}>
                    {stream.name} [{stream.type.toUpperCase()}]
                </span>
                <div className="flex gap-2">
                    <span className={`bg-black px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] ${isStreaming ? "text-[var(--color-alert)] animate-pulse" : "text-[#333]"}`}>
                        {isStreaming ? "REC" : "WAITING"}
                    </span>
                    <button onClick={handleDelete} className="bg-black text-[var(--color-iron)] hover:text-red-500 hover:border-red-500 border border-[var(--color-iron)] px-1">
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

            <div className="relative flex-1 w-full h-full flex items-center justify-center overflow-hidden">
                {!videoLoaded && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0d0d0d] z-30">
                        <div className="flex gap-1 mb-4">
                            {[0, 1, 2].map((i) => (
                                <motion.div
                                    key={i}
                                    animate={{ opacity: [0.3, 1, 0.3] }}
                                    transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                                    className="w-8 h-8 bg-[var(--color-iron)]"
                                />
                            ))}
                        </div>
                        <div className="text-[10px] font-bold tracking-[0.2em] text-[var(--color-data)]">
                            [{netState.replace(/_/g, " ").toUpperCase()}]
                        </div>
                    </div>
                )}

                {isClientCam && isOwner ? (
                    /* Owner sees their own camera via <video> element */
                    <video
                        ref={videoRef}
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        style={{ transform: "translateZ(0)" }}
                        autoPlay
                        playsInline
                        muted
                    />
                ) : (
                    /* Viewers + non-client see base64 frames from WebSocket */
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={fallbackFrame || ""}
                        alt="Stream"
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        onLoad={() => setVideoLoaded(true)}
                    />
                )}

                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />

                {showPlayButton && (
                    <div
                        className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 cursor-pointer"
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowPlayButton(false);
                            videoRef.current?.play().catch(() => undefined);
                        }}
                    >
                        <div className="w-16 h-16 rounded-full bg-white/20 border-2 border-white flex items-center justify-center backdrop-blur-sm">
                            <Play className="w-8 h-8 text-white ml-1" fill="white" />
                        </div>
                    </div>
                )}
            </div>
        </motion.div>
    );
}
