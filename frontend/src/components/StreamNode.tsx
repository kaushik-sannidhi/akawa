"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Trash2, Volume2, VolumeX, Play } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";
import Peer from "peerjs";

/* ------------------------------------------------------------------ */
/*  ICE servers: Google STUN + Metered.ca TURN                         */
/* ------------------------------------------------------------------ */
const ICE_CONFIG: RTCConfiguration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.relay.metered.ca:80" },
        {
            urls: "turn:standard.relay.metered.ca:80",
            username: "3f0bc0c30c289811fa744d56",
            credential: "5TUFbNzRr++6+B9x",
        },
        {
            urls: "turn:standard.relay.metered.ca:80?transport=tcp",
            username: "3f0bc0c30c289811fa744d56",
            credential: "5TUFbNzRr++6+B9x",
        },
        {
            urls: "turn:standard.relay.metered.ca:443",
            username: "3f0bc0c30c289811fa744d56",
            credential: "5TUFbNzRr++6+B9x",
        },
        {
            urls: "turns:standard.relay.metered.ca:443?transport=tcp",
            username: "3f0bc0c30c289811fa744d56",
            credential: "5TUFbNzRr++6+B9x",
        },
    ],
};

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */
interface StreamNodeProps {
    stream: any;
    onDelete: (id: string, cascadeDelete: boolean) => void;
    onDetections: (detections: any[], timestamp: number) => void;
    onSelect?: () => void;
    isPrimary?: boolean;
}

/* ================================================================== */
/*  STREAM NODE                                                        */
/* ================================================================== */
export default function StreamNode({
    stream,
    onDelete,
    onDetections,
    onSelect,
    isPrimary = false,
}: StreamNodeProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const peerRef = useRef<Peer | null>(null);
    const providerWsRef = useRef<WebSocket | null>(null);

    // Stable refs for callbacks (avoid effect re-triggers)
    const onDetectionsRef = useRef(onDetections);
    onDetectionsRef.current = onDetections;

    const [isStreaming, setIsStreaming] = useState(false);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isMuted, setIsMuted] = useState(true);
    const [showPlayButton, setShowPlayButton] = useState(false);
    const [netState, setNetState] = useState<string>("init");

    const [localDeviceId] = useState(() => {
        if (typeof window !== "undefined") {
            let id = localStorage.getItem("device_id");
            if (!id) {
                id = Math.random().toString(36).substring(2, 15);
                localStorage.setItem("device_id", id);
            }
            return id;
        }
        return "";
    });

    const isOwner = stream.type === "client_cam" && stream.device_id === localDeviceId;
    const isClientCam = stream.type === "client_cam";

    /** Derive a deterministic PeerJS ID from the stream ID */
    const peerIdForStream = `akawa-${stream.id}`;

    /* ------------------------------------------------------------------ */
    /*  Detection overlay drawing                                          */
    /* ------------------------------------------------------------------ */
    const drawDetections = useCallback((detections: any[]) => {
        if (!overlayRef.current) return;
        const displayW = overlayRef.current.clientWidth || 640;
        const displayH = overlayRef.current.clientHeight || 480;

        if (overlayRef.current.width !== displayW || overlayRef.current.height !== displayH) {
            overlayRef.current.width = displayW;
            overlayRef.current.height = displayH;
        }

        const ctx = overlayRef.current.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, displayW, displayH);

        const scale = Math.max(displayW / 1280, 0.4);
        const lineW = Math.max(2, 2 * scale);
        const fontSize = Math.round(Math.max(9, 10 * scale));
        const labelH = Math.round(Math.max(14, 20 * scale));

        detections.forEach((det: any) => {
            if (det.confidence < 0.45) return;
            const bbox = det.bbox;
            const x1 = (bbox.x1 ?? bbox[0]) * displayW;
            const y1 = (bbox.y1 ?? bbox[1]) * displayH;
            const x2 = (bbox.x2 ?? bbox[2]) * displayW;
            const y2 = (bbox.y2 ?? bbox[3]) * displayH;
            const isWeapon = ["rifle", "handgun", "knife", "weapon"].includes(det.class_name);
            const color = isWeapon ? "#FF3300" : "#FFFFFF";

            const corner = Math.max(6, 10 * scale);
            ctx.strokeStyle = color;
            ctx.lineWidth = lineW;
            ctx.beginPath();
            ctx.moveTo(x1, y1 + corner); ctx.lineTo(x1, y1); ctx.lineTo(x1 + corner, y1);
            ctx.moveTo(x2 - corner, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + corner);
            ctx.moveTo(x2, y2 - corner); ctx.lineTo(x2, y2); ctx.lineTo(x2 - corner, y2);
            ctx.moveTo(x1 + corner, y2); ctx.lineTo(x1, y2); ctx.lineTo(x1, y2 - corner);
            ctx.stroke();

            const text = `${det.class_name.toUpperCase()} ${(det.confidence * 100).toFixed(0)}%`;
            ctx.font = `bold ${fontSize}px monospace`;
            const tw = ctx.measureText(text).width + 8;
            ctx.fillStyle = isWeapon ? "rgba(255,51,0,0.75)" : "rgba(255,255,255,0.65)";
            ctx.fillRect(x1, y1 - labelH, tw, labelH);

            ctx.fillStyle = isWeapon ? "#FFFFFF" : "#000000";
            ctx.fillText(text, x1 + 4, y1 - (labelH * 0.25));
        });
    }, []);

    const drawDetectionsRef = useRef(drawDetections);
    drawDetectionsRef.current = drawDetections;

    /* ================================================================== */
    /*  Effect 1: PROVIDER — camera + PeerJS + AI frame sender             */
    /*  (client_cam owner only)                                            */
    /* ================================================================== */
    useEffect(() => {
        if (!isClientCam || !isOwner) return;

        let active = true;
        const wsUrl = getWsUrl();

        const startProvider = async () => {
            if (!active) return;
            setNetState("starting_camera");

            try {
                // 1. Acquire camera
                const mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
                    audio: true,
                });
                if (!active) { mediaStream.getTracks().forEach(t => t.stop()); return; }
                localStreamRef.current = mediaStream;

                // Show local preview
                if (videoRef.current) {
                    videoRef.current.srcObject = mediaStream;
                    videoRef.current.muted = true;
                    videoRef.current.play().catch(() => { });
                    setVideoLoaded(true);
                }
                setIsStreaming(true);
                setNetState("creating_peer");

                // 2. Create PeerJS peer with deterministic ID
                const peer = new Peer(peerIdForStream, { config: ICE_CONFIG });
                peerRef.current = peer;

                peer.on("open", () => {
                    if (!active) return;
                    setNetState("broadcasting");
                    console.log(`[Provider] PeerJS ready: ${peer.id}`);
                });

                // Answer any incoming viewer calls with our media stream
                peer.on("call", (call) => {
                    if (!active) return;
                    console.log(`[Provider] Answering call from viewer`);
                    call.answer(mediaStream);
                });

                peer.on("error", (err) => {
                    console.error("[Provider] PeerJS error:", err.type, err.message);
                    if (err.type === "unavailable-id") {
                        // Peer ID still cached — retry after short delay
                        setNetState("reconnecting");
                        setTimeout(() => {
                            if (active && peerRef.current) {
                                peerRef.current.destroy();
                                peerRef.current = null;
                            }
                            if (active) startProvider();
                        }, 3000);
                    }
                });

                peer.on("disconnected", () => {
                    if (active) {
                        setNetState("reconnecting");
                        peer.reconnect();
                    }
                });

                // 3. Open WS to send low-res AI frames to backend
                const aiWs = new WebSocket(`${wsUrl}/ws/stream_in/${stream.id}`);
                providerWsRef.current = aiWs;
                let sending = false;
                let captureInterval: ReturnType<typeof setInterval> | null = null;

                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d", { willReadFrequently: false });

                aiWs.binaryType = "arraybuffer";

                aiWs.onopen = () => {
                    captureInterval = setInterval(() => {
                        if (!active || aiWs.readyState !== WebSocket.OPEN || !videoRef.current) return;
                        if (videoRef.current.readyState < 2 || sending) return;

                        const vw = videoRef.current.videoWidth;
                        const vh = videoRef.current.videoHeight;
                        if (!vw || !vh) return;

                        // Low res for AI only (viewers get full-res via WebRTC)
                        const targetW = 384;
                        const scale = targetW / vw;
                        canvas.width = targetW;
                        canvas.height = Math.round(vh * scale);
                        ctx?.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

                        sending = true;
                        canvas.toBlob(
                            (blob) => {
                                sending = false;
                                if (!blob || aiWs.readyState !== WebSocket.OPEN) return;
                                aiWs.send(blob); // Raw binary JPEG
                            },
                            "image/jpeg",
                            0.5,
                        );
                    }, 150); // ~6-7 FPS for AI inference
                };

                aiWs.onclose = () => {
                    if (captureInterval) clearInterval(captureInterval);
                    // Reconnect WS for AI frames
                    if (active) {
                        setTimeout(() => {
                            if (!active) return;
                            const newWs = new WebSocket(`${wsUrl}/ws/stream_in/${stream.id}`);
                            providerWsRef.current = newWs;
                            newWs.binaryType = "arraybuffer";
                            newWs.onopen = aiWs.onopen;
                            newWs.onclose = aiWs.onclose;
                        }, 2000);
                    }
                };
            } catch (err) {
                console.error("[Provider] camera fail:", err);
                setNetState("camera_error");
            }
        };

        startProvider();

        return () => {
            active = false;
            if (providerWsRef.current) { providerWsRef.current.close(); providerWsRef.current = null; }
            if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(t => t.stop());
                localStreamRef.current = null;
            }
        };
    }, [isClientCam, isOwner, stream.id, peerIdForStream]);

    /* ================================================================== */
    /*  Effect 2: VIEWER — PeerJS WebRTC call to provider                  */
    /*  (client_cam non-owner only)                                        */
    /* ================================================================== */
    useEffect(() => {
        if (!isClientCam || isOwner) return;

        let active = true;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const connectViewer = () => {
            if (!active) return;
            setNetState("connecting_peer");

            const peer = new Peer({ config: ICE_CONFIG });
            peerRef.current = peer;

            peer.on("open", () => {
                if (!active) return;
                setNetState("calling_provider");
                console.log(`[Viewer] PeerJS open, calling provider: ${peerIdForStream}`);

                // Call the provider's peer with no local stream (receive-only)
                const call = peer.call(peerIdForStream, new MediaStream());

                call.on("stream", (remoteStream) => {
                    if (!active) return;
                    console.log("[Viewer] Got remote stream from provider");
                    if (videoRef.current) {
                        videoRef.current.srcObject = remoteStream;
                        videoRef.current.play().catch(() => setShowPlayButton(true));
                        setVideoLoaded(true);
                        setIsStreaming(true);
                        setNetState("streaming");
                    }
                });

                call.on("close", () => {
                    if (!active) return;
                    setVideoLoaded(false);
                    setIsStreaming(false);
                    setNetState("reconnecting");
                    retryTimer = setTimeout(() => {
                        if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
                        connectViewer();
                    }, 3000);
                });

                call.on("error", (err) => {
                    console.error("[Viewer] Call error:", err);
                    setNetState("reconnecting");
                    retryTimer = setTimeout(() => {
                        if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
                        connectViewer();
                    }, 3000);
                });
            });

            peer.on("error", (err) => {
                console.error("[Viewer] PeerJS error:", err.type, err.message);
                if (err.type === "peer-unavailable") {
                    // Provider not online yet — retry
                    setNetState("waiting_for_camera");
                } else {
                    setNetState("reconnecting");
                }
                retryTimer = setTimeout(() => {
                    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
                    connectViewer();
                }, 4000);
            });

            peer.on("disconnected", () => {
                if (active) peer.reconnect();
            });
        };

        connectViewer();

        return () => {
            active = false;
            if (retryTimer) clearTimeout(retryTimer);
            if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
        };
    }, [isClientCam, isOwner, stream.id, peerIdForStream]);

    /* ================================================================== */
    /*  Effect 3: VIEWER — server_cam / rtsp via WebSocket frame relay      */
    /* ================================================================== */
    useEffect(() => {
        if (isClientCam) return;

        let active = true;
        const wsUrl = getWsUrl();
        let viewerWs: WebSocket | null = null;
        let pingInterval: ReturnType<typeof setInterval> | null = null;
        let loadedOnce = false;
        let prevBlobUrl: string | null = null;

        const connect = () => {
            if (!active) return;
            setNetState("connecting_ws");
            viewerWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
            viewerWs.binaryType = "blob";

            viewerWs.onopen = () => {
                setNetState("streaming");
                setIsStreaming(true);
                pingInterval = setInterval(() => {
                    if (viewerWs?.readyState === WebSocket.OPEN) viewerWs.send("ping");
                }, 15000);
            };

            viewerWs.onmessage = (event) => {
                if (event.data instanceof Blob) {
                    if (imgRef.current) {
                        const url = URL.createObjectURL(event.data);
                        if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
                        prevBlobUrl = url;
                        imgRef.current.src = url;
                        if (!loadedOnce) { loadedOnce = true; setVideoLoaded(true); }
                    }
                } else if (typeof event.data === "string") {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.detections) {
                            requestAnimationFrame(() => drawDetectionsRef.current(data.detections));
                            onDetectionsRef.current(data.detections, data.timestamp);
                        }
                    } catch { /* ignore */ }
                }
            };

            viewerWs.onclose = () => {
                if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
                setIsStreaming(false);
                if (active) setTimeout(connect, 3000);
            };
        };

        connect();

        return () => {
            active = false;
            if (pingInterval) clearInterval(pingInterval);
            if (viewerWs) viewerWs.close();
            if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
        };
    }, [isClientCam, stream.id]);

    /* ================================================================== */
    /*  Effect 4: Detection overlay — all client_cam users subscribe to     */
    /*  stream_out for AI detection results                                 */
    /* ================================================================== */
    useEffect(() => {
        if (!isClientCam) return; // server_cam gets detections in Effect 3

        let active = true;
        const wsUrl = getWsUrl();
        let detWs: WebSocket | null = null;
        let pingInterval: ReturnType<typeof setInterval> | null = null;

        const connectDetWs = () => {
            if (!active) return;
            detWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
            detWs.binaryType = "blob"; // ignore any binary

            detWs.onopen = () => {
                pingInterval = setInterval(() => {
                    if (detWs?.readyState === WebSocket.OPEN) detWs.send("ping");
                }, 15000);
            };

            detWs.onmessage = (event) => {
                if (typeof event.data === "string") {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.detections) {
                            requestAnimationFrame(() => drawDetectionsRef.current(data.detections));
                            onDetectionsRef.current(data.detections, data.timestamp);
                        }
                    } catch { /* ignore */ }
                }
            };

            detWs.onclose = () => {
                if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
                if (active) setTimeout(connectDetWs, 3000);
            };
        };

        connectDetWs();

        return () => {
            active = false;
            if (pingInterval) clearInterval(pingInterval);
            if (detWs) detWs.close();
        };
    }, [isClientCam, stream.id]);

    /* ------------------------------------------------------------------ */
    /*  Audio mute                                                         */
    /* ------------------------------------------------------------------ */
    useEffect(() => {
        if (videoRef.current) videoRef.current.muted = isOwner ? true : isMuted;
    }, [isMuted, isOwner]);

    /* ------------------------------------------------------------------ */
    /*  Delete handler                                                     */
    /* ------------------------------------------------------------------ */
    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const confirmed = window.confirm(`Terminate ${stream.name}? This removes it for all users.`);
        if (confirmed) {
            if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
            if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
            if (providerWsRef.current) providerWsRef.current.close();
            onDelete(stream.id, true);
        }
    };

    /* ================================================================== */
    /*  RENDER                                                             */
    /* ================================================================== */
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

            {/* Corner markers */}
            <div className="absolute top-4 left-4 border-l-[2px] border-t-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute top-4 right-4 border-r-[2px] border-t-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute bottom-4 left-4 border-l-[2px] border-b-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute bottom-4 right-4 border-r-[2px] border-b-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />

            {/* Header bar */}
            <div className={`p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent ${!isPrimary ? "bg-black border-b-[2px] border-[var(--color-iron)]" : ""} absolute top-0 left-0 w-full`}>
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[150px]`}>
                    {stream.name} [{stream.type.toUpperCase()}]
                </span>
                <div className="flex gap-2">
                    {isClientCam && (
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsMuted(!isMuted); }}
                            className={`bg-black border border-[var(--color-iron)] px-1 flex items-center justify-center ${isMuted ? 'text-[var(--color-silica)]' : 'text-[var(--color-data)]'} hover:text-white`}
                            title={isMuted ? "Unmute audio" : "Mute audio"}
                        >
                            {isMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                        </button>
                    )}
                    <span className={`bg-black px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] ${isStreaming ? 'text-[var(--color-alert)] animate-pulse' : 'text-[#333]'}`}>
                        {isStreaming ? 'REC' : 'WAITING'}
                    </span>
                    <button onClick={handleDelete} className="bg-black text-[var(--color-iron)] hover:text-red-500 hover:border-red-500 border border-[var(--color-iron)] px-1">
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {/* Video area */}
            <div className="relative flex-1 w-full h-full flex items-center justify-center overflow-hidden">
                {!videoLoaded && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0d0d0d] z-30">
                        <div className="relative flex flex-col items-center">
                            <div className="relative w-16 h-16 mb-6">
                                <div className="absolute inset-0 border border-[var(--color-iron)] border-t-[var(--color-data)] rounded-full animate-spin" style={{ animationDuration: '2s' }} />
                                <div className="absolute inset-1.5 border border-[var(--color-iron)] border-b-[var(--color-data)] rounded-full animate-spin" style={{ animationDuration: '1.5s', animationDirection: 'reverse' }} />
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="w-3 h-3 bg-[var(--color-data)] rounded-sm animate-ping" />
                                </div>
                            </div>
                            <div className="text-[10px] font-bold tracking-[0.2em] text-[var(--color-data)] flex items-center gap-2">
                                <span>[</span>
                                <span className="w-48 text-center uppercase tracking-[0.3em]">
                                    {netState.replace(/_/g, " ")}
                                </span>
                                <span>]</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Video element for WebRTC streams (client_cam) */}
                {isClientCam && (
                    <video
                        ref={videoRef}
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        style={{ transform: "translateZ(0)" }}
                        autoPlay={true}
                        playsInline={true}
                        muted={isOwner ? true : isMuted}
                    />
                )}

                {/* Image element for WS relay streams (server_cam / rtsp) */}
                {!isClientCam && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img ref={imgRef} className="absolute inset-0 h-full w-full object-cover z-10" alt="Stream" />
                )}

                {/* Detection overlay */}
                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />

                {/* Manual play button (mobile autoplay restriction) */}
                {showPlayButton && (
                    <div
                        className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); setShowPlayButton(false); videoRef.current?.play().catch(() => { }); }}
                    >
                        <div className="w-16 h-16 rounded-full bg-white/20 border-2 border-white flex items-center justify-center backdrop-blur-sm">
                            <Play className="w-8 h-8 text-white ml-1" fill="white" />
                        </div>
                        <span className="absolute bottom-4 text-[10px] font-mono font-bold text-white/80 tracking-widest">TAP TO START FEED</span>
                    </div>
                )}
            </div>
        </motion.div>
    );
}