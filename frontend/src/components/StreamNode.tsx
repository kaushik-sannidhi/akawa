"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2, Wifi, WifiOff, Mic, MicOff, Volume2, VolumeX, Camera, CameraOff } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";

interface StreamNodeProps {
    stream: any;
    onDelete: (id: string, cascadeDelete: boolean) => void;
    onDetections: (detections: any[], timestamp: number) => void;
    onSelect?: () => void;
    onDoubleClick?: () => void;
    isPrimary?: boolean;
}

export default function StreamNode({
    stream,
    onDelete,
    onDetections,
    onSelect,
    onDoubleClick,
    isPrimary = false,
}: StreamNodeProps) {
    if (!stream) {
        return <div className="p-4 text-xs font-mono text-red-500">[ERROR: STREAM_UNDEFINED]</div>;
    }

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const hiddenVideoRef = useRef<HTMLVideoElement>(null);
    const viewerImgRef = useRef<HTMLImageElement>(null);

    const [isStreaming, setIsStreaming] = useState(false);
    const [netState, setNetState] = useState("init");
    const [localDeviceId, setLocalDeviceId] = useState("");

    const [videoEnabled, setVideoEnabled] = useState(true);
    const [audioEnabled, setAudioEnabled] = useState(true);
    const [viewerMuted, setViewerMuted] = useState(false);

    const localStreamRef = useRef<MediaStream | null>(null);

    // Pulse animation logic
    const pulsePhaseRef = useRef<number>(0);
    const rafRef = useRef<number>(0);
    const lastDetectionsRaw = useRef<any[]>([]);
    const weaponSeenStartRef = useRef<number | null>(null);
    const lastObjectUrlRef = useRef<string | null>(null);

    const isOwner = useMemo(
        () => stream.device_id === localDeviceId && !!localDeviceId,
        [localDeviceId, stream.device_id],
    );

    useEffect(() => {
        let id = localStorage.getItem("device_id");
        if (!id) {
            id = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", id);
        }
        setLocalDeviceId(id);

        const animate = (time: number) => {
            pulsePhaseRef.current = (time % 1000) / 1000;
            if (lastDetectionsRaw.current.length > 0) {
                // Re-draw detections using the last known frame
                // We rely on the received WebSocket frame actually keeping the canvas updated.
                // Normally we'd composite, but here we can just draw them over the canvas.
                // Wait, if we keep clearing canvas, it flashes pink. We only want to draw over the existing frame.
            }
            rafRef.current = requestAnimationFrame(animate);
        };

        rafRef.current = requestAnimationFrame(animate);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    // Helper: Draw single frame
    const drawFrameAndDetections = useCallback((detections?: any[]) => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Size the canvas to the video/img
        const video = hiddenVideoRef.current;
        const img = viewerImgRef.current;

        let targetWidth = 640;
        let targetHeight = 480;

        if (isOwner && video && video.videoWidth > 0) {
            targetWidth = video.videoWidth;
            targetHeight = video.videoHeight;
        } else if (!isOwner && img && img.naturalWidth > 0) {
            targetWidth = img.naturalWidth;
            targetHeight = img.naturalHeight;
        }

        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const dw = canvas.width;
        const dh = canvas.height;

        const currentDets = detections || lastDetectionsRaw.current;
        if (detections) {
            lastDetectionsRaw.current = detections;
        }

        const phase = pulsePhaseRef.current;
        const pulseOpacity = 0.4 + 0.6 * (Math.sin(phase * Math.PI * 2) * 0.5 + 0.5);
        const hasWeapon = currentDets.some(
            (d) =>
                (d.detection_type === "weapon" || d.class_name === "gun" || d.class_name === "weapon") &&
                d.confidence >= 0.45,
        );

        if (hasWeapon) {
            if (weaponSeenStartRef.current === null) {
                weaponSeenStartRef.current = Date.now();
            }
        } else {
            weaponSeenStartRef.current = null;
        }

        const isPersistentWeapon =
            weaponSeenStartRef.current !== null && Date.now() - weaponSeenStartRef.current > 1000;

        currentDets.forEach((det: any) => {
            const detType = det.detection_type ?? "";
            const isWeapon = detType === "weapon" || det.class_name === "gun" || det.class_name === "weapon";
            const isPerson = det.class_name === "person";
            if (det.confidence < (isPerson ? 0.25 : 0.45)) return;

            const b = det.bbox;
            const x1 = (b.x1 ?? b[0]) * dw;
            const y1 = (b.y1 ?? b[1]) * dh;
            const x2 = (b.x2 ?? b[2]) * dw;
            const y2 = (b.y2 ?? b[3]) * dh;
            const width = x2 - x1;
            const height = y2 - y1;

            if (isWeapon && isPersistentWeapon) {
                const baseColor = `rgba(255,51,0,${pulseOpacity})`;
                for (let i = 1; i <= 3; i++) {
                    const offset = i * 4;
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = `rgba(255,51,0,${pulseOpacity * (0.3 / i)})`;
                    ctx.strokeRect(x1 - offset, y1 - offset, width + offset * 2, height + offset * 2);
                }
                ctx.strokeStyle = baseColor;
                ctx.lineWidth = 4;
                ctx.strokeRect(x1, y1, width, height);
                ctx.fillStyle = `rgba(255,51,0,${pulseOpacity * 0.2})`;
                ctx.fillRect(x1, y1, width, height);

                const label = `${(det.class_name || "WEAPON").toUpperCase()} ${(det.confidence * 100).toFixed(0)}%`;
                ctx.font = "bold 14px Inter,sans-serif";
                const textWidth = ctx.measureText(label).width;
                ctx.fillStyle = "#FF3300";
                ctx.fillRect(x1, y1 - 22, textWidth + 12, 22);
                ctx.fillStyle = "white";
                ctx.fillText(label, x1 + 6, y1 - 6);
            } else {
                let color = "rgba(200,200,200,0.5)";
                if (detType === "violent_person") color = "rgba(204,51,255,0.7)";
                else if (detType === "fall") color = "rgba(255,153,0,0.7)";
                else if (det.class_name === "knife" || detType === "knife") color = "rgba(255,255,0,0.8)";

                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                ctx.strokeRect(x1, y1, width, height);
                ctx.fillStyle = color
                    .replace("0.5", "0.05")
                    .replace("0.7", "0.07")
                    .replace("0.8", "0.1");
                ctx.fillRect(x1, y1, width, height);
            }
        });
    }, [isOwner]);

    // Owner logic: capture local camera and publish frames
    useEffect(() => {
        if (!isOwner) return;

        let alive = true;
        let ws: WebSocket | null = null;
        let rafId: number | null = null;
        let lastCaptureTime = 0;
        const targetFps = 15;
        const frameInterval = 1000 / targetFps;

        const connectCamera = async () => {
            try {
                const isClientCam = stream.type === "client_cam";
                const deviceIdConstraint = isClientCam && stream.source && stream.source !== "local"
                    ? { exact: stream.source } : undefined;

                const constraints: MediaStreamConstraints = {
                    video: deviceIdConstraint
                        ? { deviceId: deviceIdConstraint, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } }
                        : { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
                    audio: true,
                };

                const userMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
                if (!alive) {
                    userMediaStream.getTracks().forEach((t) => t.stop());
                    return;
                }
                localStreamRef.current = userMediaStream;
                if (hiddenVideoRef.current) {
                    hiddenVideoRef.current.srcObject = userMediaStream;
                }
            } catch (e) {
                console.error("Failed to access camera:", e);
                setNetState("camera_error");
            }
        };

        const connectWebSocket = () => {
            if (!alive) return;
            setNetState("connecting_ws");
            setIsStreaming(false);

            const wsUrl = getWsUrl(`/ws/stream_in/${stream.id}`);
            ws = new WebSocket(wsUrl);
            ws.binaryType = "arraybuffer";

            let pingInterval: ReturnType<typeof setInterval> | null = null;
            ws.onopen = () => {
                setNetState("streaming");
                setIsStreaming(true);

                const captureCanvas = document.createElement("canvas");
                const captureCtx = captureCanvas.getContext("2d", { alpha: false });

                pingInterval = setInterval(() => {
                    if (ws?.readyState === WebSocket.OPEN) ws.send(new Blob([]));
                }, 15000);

                const publishLoop = (now: number) => {
                    if (!alive) return;

                    if (now - lastCaptureTime >= frameInterval) {
                        const video = hiddenVideoRef.current;
                        if (video && captureCtx && video.readyState >= 2 && videoEnabled) {
                            captureCanvas.width = 640;
                            captureCanvas.height = Math.max(1, Math.round((640 / video.videoWidth) * video.videoHeight));
                            captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

                            captureCanvas.toBlob(
                                (blob) => {
                                    if (blob && ws?.readyState === WebSocket.OPEN) {
                                        // Drop frame client-side if buffer > 2MB to prevent disconnect
                                        if (ws.bufferedAmount < 2000000) {
                                            ws.send(blob);
                                        }
                                    }
                                },
                                "image/jpeg",
                                0.5,
                            );
                            lastCaptureTime = now;
                        }
                    }
                    rafId = requestAnimationFrame(publishLoop);
                };
                rafId = requestAnimationFrame(publishLoop);
            };

            ws.onerror = () => setIsStreaming(false);
            ws.onclose = () => {
                if (pingInterval) clearInterval(pingInterval);
                setNetState("reconnecting");
                setIsStreaming(false);
                if (rafId) cancelAnimationFrame(rafId);
                if (alive) setTimeout(connectWebSocket, 3000);
            };
        };

        void connectCamera().then(() => connectWebSocket());

        return () => {
            alive = false;
            if (rafId) cancelAnimationFrame(rafId);
            if (ws) ws.close();
            // Interval clears on ws.onclose, but to be safe:
        };
    }, [isOwner, stream.id, videoEnabled]);

    // Viewer / Box receiving logic (Owner needs boxes too!)
    useEffect(() => {
        let alive = true;
        let ws: WebSocket | null = null;
        let pingInterval: ReturnType<typeof setInterval> | null = null;

        const connectViewerWs = () => {
            if (!alive) return;

            const wsUrl = getWsUrl(`/ws/viewer/${stream.id}`);
            ws = new WebSocket(wsUrl);
            ws.binaryType = "blob";

            ws.onopen = (e) => {
                if (!isOwner) {
                    setNetState("streaming");
                    setIsStreaming(true);
                }
                pingInterval = setInterval(() => {
                    if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
                }, 20000);
            };

            ws.onmessage = async (event) => {
                if (!alive) return;
                if (typeof event.data === "string") {
                    try {
                        const payload = JSON.parse(event.data);
                        if (payload.detections) {
                            onDetections(payload.detections, Number(payload.timestamp || Date.now()));
                            drawFrameAndDetections(payload.detections);
                        }
                    } catch (e) {
                        // ignore
                    }
                } else {
                    // Binary JPEG fast path
                    if (isOwner) return; // Owner draws local video

                    try {
                        const blob = event.data instanceof Blob ? event.data : new Blob([event.data]);
                        const url = URL.createObjectURL(blob);
                        if (viewerImgRef.current) {
                            viewerImgRef.current.src = url;
                        }
                        if (lastObjectUrlRef.current) {
                            URL.revokeObjectURL(lastObjectUrlRef.current);
                        }
                        lastObjectUrlRef.current = url;
                    } catch (e) {
                        // ignore error
                    }
                }
            };

            ws.onclose = () => {
                if (pingInterval) clearInterval(pingInterval);
                if (!isOwner) {
                    setNetState("reconnecting");
                    setIsStreaming(false);
                }
                if (alive) setTimeout(connectViewerWs, 3000);
            };
        };

        connectViewerWs();

        return () => {
            alive = false;
            if (ws) ws.close();
            if (pingInterval) clearInterval(pingInterval);
            if (lastObjectUrlRef.current) URL.revokeObjectURL(lastObjectUrlRef.current);
        };
    }, [drawFrameAndDetections, isOwner, onDetections, stream.id]);

    // Track toggling
    useEffect(() => {
        if (!localStreamRef.current) return;
        localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = videoEnabled));
        localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = audioEnabled));
    }, [videoEnabled, audioEnabled]);

    const handleDelete = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (window.confirm(`Terminate ${stream.name}?`)) {
            onDelete(stream.id, true);
        }
    };

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 35, mass: 0.6 }}
            onClick={() => onSelect?.()}
            onDoubleClick={(event) => {
                event.stopPropagation();
                onDoubleClick?.();
            }}
            className={`relative w-full h-full flex-1 min-h-0 bg-[#0A0A0A] flex flex-col group cursor-pointer origin-center border-[2px] overflow-hidden ${isPrimary
                ? "border-[var(--color-data)]"
                : "border-[var(--color-dim)] hover:border-[var(--color-iron)]"
                }`}
        >
            <div className="p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 w-full">
                <span
                    className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"
                        } border-[1px] border-[var(--color-iron)] truncate max-w-[180px] whitespace-nowrap`}
                >
                    {stream.name} [FASTAPI_NODE]
                </span>
                <div className="flex gap-1">
                    <span
                        className={`bg-black px-1 border border-[var(--color-iron)] flex items-center ${isStreaming ? "text-[var(--color-data)]" : "text-[#555]"
                            }`}
                    >
                        {isStreaming ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                    </span>
                    <span
                        className={`bg-black px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"
                            } border-[1px] border-[var(--color-iron)] ${isStreaming ? "text-[var(--color-alert)] animate-pulse" : "text-[#333]"
                            }`}
                    >
                        {isStreaming ? "LIVE" : "..."}
                    </span>
                    <button
                        onClick={handleDelete}
                        className="bg-black text-[var(--color-iron)] hover:text-red-500 hover:border-red-500 border border-[var(--color-iron)] px-1 relative z-50 pointer-events-auto"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

            <div className="relative flex-1 w-full h-full flex items-center justify-center overflow-hidden">
                {!isStreaming && (
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
                        <div className="text-[10px] font-bold tracking-[0.2em] text-[var(--color-data)] whitespace-nowrap">
                            [{netState.replace(/_/g, " ").toUpperCase()}]
                        </div>
                    </div>
                )}

                {/* For Publisher, we show the local video directly under the canvas for zero latency */}
                {isOwner ? (
                    <video
                        ref={hiddenVideoRef}
                        muted
                        autoPlay
                        playsInline
                        className="absolute inset-0 w-full h-full object-cover z-10"
                    />
                ) : (
                    <img
                        ref={viewerImgRef}
                        className="absolute inset-0 w-full h-full object-cover z-10"
                        alt="Stream Frame"
                    />
                )}

                <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover z-20 pointer-events-none" />

                {/* Controls Overlay */}
                <div className="absolute bottom-4 right-4 z-50 flex gap-2 pointer-events-auto">
                    {isOwner ? (
                        <>
                            <button
                                onClick={(e) => { e.stopPropagation(); setAudioEnabled(!audioEnabled); }}
                                className={`px-3 py-2 text-[10px] font-bold border-[2px] flex items-center gap-2 transition-colors ${audioEnabled
                                    ? "border-[var(--color-data)] bg-[var(--color-data)] text-black hover:bg-white"
                                    : "border-[var(--color-alert)] bg-[var(--color-alert)] text-black hover:bg-white"
                                    }`}
                            >
                                {audioEnabled ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />}
                                {audioEnabled ? "MIC_ON" : "MIC_OFF"}
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); setVideoEnabled(!videoEnabled); }}
                                className={`px-3 py-2 text-[10px] font-bold border-[2px] flex items-center gap-2 transition-colors ${videoEnabled
                                    ? "border-[var(--color-silica)] bg-black text-white hover:border-white"
                                    : "border-[var(--color-iron)] bg-[var(--color-iron)] text-[var(--color-silica)]"
                                    }`}
                            >
                                {videoEnabled ? <Camera className="w-3 h-3" /> : <CameraOff className="w-3 h-3" />}
                                {videoEnabled ? "CAM_ON" : "CAM_OFF"}
                            </button>
                        </>
                    ) : (
                        <button
                            onClick={(e) => { e.stopPropagation(); setViewerMuted(!viewerMuted); }}
                            className={`px-3 py-2 text-[10px] font-bold border-[2px] flex items-center gap-2 transition-colors ${!viewerMuted
                                ? "border-[var(--color-data)] bg-[var(--color-data)] text-black hover:bg-white"
                                : "border-[var(--color-alert)] bg-[var(--color-alert)] text-black hover:bg-white"
                                }`}
                        >
                            {!viewerMuted ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                            {!viewerMuted ? "VOL_ON" : "VOL_MUTED"}
                        </button>
                    )}
                </div>
            </div>
        </motion.div>
    );
}