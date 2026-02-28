"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Trash2, Play, Volume2, VolumeX } from "lucide-react";
import { motion } from "framer-motion";
import { getBaseUrl, getWsUrl } from "@/lib/config";
import { getPeerConfig, makePeerId } from "@/lib/webrtcConfig";
import Peer, { MediaConnection } from "peerjs";

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
/*  STREAM NODE — WebRTC (PeerJS) Architecture                         */
/*  Provider → PeerJS (WebRTC P2P) → All Viewers (video + audio)       */
/*  Provider → binary WS (stream_in) → Backend (AI only)              */
/*  Backend → text WS (stream_out) → All clients (detection JSON)      */
/* ================================================================== */
export default function StreamNode({
    stream,
    onDelete,
    onDetections,
    onSelect,
    isPrimary = false,
}: StreamNodeProps) {
    /* ---- refs ---- */
    const videoRef = useRef<HTMLVideoElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const providerWsRef = useRef<WebSocket | null>(null);
    const peerRef = useRef<Peer | null>(null);
    const activeCallsRef = useRef<Set<MediaConnection>>(new Set());

    // Stable callback refs — never cause effect re-runs
    const onDetectionsRef = useRef(onDetections);
    onDetectionsRef.current = onDetections;

    /* ---- state ---- */
    const [isStreaming, setIsStreaming] = useState(false);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [showPlayButton, setShowPlayButton] = useState(false);
    const [netState, setNetState] = useState<string>("init");
    const [isMuted, setIsMuted] = useState(true);

    /* ---- identity ---- */
    const [localDeviceId] = useState(() => {
        if (typeof window === "undefined") return "";
        let id = localStorage.getItem("device_id");
        if (!id) {
            id = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", id);
        }
        return id;
    });

    const isOwner = stream.type === "client_cam" && stream.device_id === localDeviceId;
    const isClientCam = stream.type === "client_cam";

    /* ------------------------------------------------------------------ */
    /*  Detection overlay drawing                                          */
    /* ------------------------------------------------------------------ */
    const lastClipTimeRef = useRef<number>(0);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);

    const drawDetections = useCallback((detections: any[]) => {
        if (!overlayRef.current) return;
        const dw = overlayRef.current.clientWidth || 640;
        const dh = overlayRef.current.clientHeight || 480;
        if (overlayRef.current.width !== dw || overlayRef.current.height !== dh) {
            overlayRef.current.width = dw;
            overlayRef.current.height = dh;
        }
        const ctx = overlayRef.current.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, dw, dh);

        const s = Math.max(dw / 1280, 0.4);
        let activeWeaponDet = false;

        detections.forEach((det: any) => {
            if (det.confidence < 0.45) return;
            const b = det.bbox;
            const x1 = (b.x1 ?? b[0]) * dw, y1 = (b.y1 ?? b[1]) * dh;
            const x2 = (b.x2 ?? b[2]) * dw, y2 = (b.y2 ?? b[3]) * dh;
            const wep = ["rifle", "handgun", "knife", "weapon"].includes(det.class_name);
            const col = wep ? "#FF3300" : "#FFFFFF";

            if (wep) activeWeaponDet = true;

            const corner = Math.max(6, 10 * s);
            ctx.strokeStyle = col;
            ctx.lineWidth = Math.max(2, 2 * s);
            ctx.beginPath();
            ctx.moveTo(x1, y1 + corner); ctx.lineTo(x1, y1); ctx.lineTo(x1 + corner, y1);
            ctx.moveTo(x2 - corner, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + corner);
            ctx.moveTo(x2, y2 - corner); ctx.lineTo(x2, y2); ctx.lineTo(x2 - corner, y2);
            ctx.moveTo(x1 + corner, y2); ctx.lineTo(x1, y2); ctx.lineTo(x1, y2 - corner);
            ctx.stroke();
            const fontSize = Math.round(Math.max(9, 10 * s));
            const labelH = Math.round(Math.max(14, 20 * s));
            const text = `${det.class_name.toUpperCase()} ${(det.confidence * 100).toFixed(0)}%`;
            ctx.font = `bold ${fontSize}px monospace`;
            const tw = ctx.measureText(text).width + 8;
            ctx.fillStyle = wep ? "rgba(255,51,0,0.75)" : "rgba(255,255,255,0.65)";
            ctx.fillRect(x1, y1 - labelH, tw, labelH);
            ctx.fillStyle = wep ? "#FFF" : "#000";
            ctx.fillText(text, x1 + 4, y1 - labelH * 0.25);
        });

        // Trigger recording of a clip if there is an active weapon and we haven't recorded one recently
        const now = Date.now();
        if (activeWeaponDet && (now - lastClipTimeRef.current > 5000) && !mediaRecorderRef.current) {
            lastClipTimeRef.current = now;
            try {
                const compRend = document.createElement("canvas");
                compRend.width = dw;
                compRend.height = dh;
                const compCtx = compRend.getContext("2d");

                const frameStream = compRend.captureStream(10);
                const recorder = new MediaRecorder(frameStream, { mimeType: "video/webm" });
                const chunks: Blob[] = [];

                recorder.ondataavailable = e => chunks.push(e.data);
                recorder.onstop = () => {
                    const clipBlob = new Blob(chunks, { type: "video/webm" });
                    mediaRecorderRef.current = null;

                    const ev = new CustomEvent('awca_clip_generated', {
                        detail: {
                            videoId: stream.id,
                            timestamp: now,
                            videoBlob: clipBlob
                        }
                    });
                    window.dispatchEvent(ev);
                };

                recorder.start();
                mediaRecorderRef.current = recorder;

                const durationMs = 4000;
                const startRec = Date.now();

                const animLoop = () => {
                    if (Date.now() - startRec > durationMs) {
                        if (recorder.state !== "inactive") recorder.stop();
                        return;
                    }
                    if (compCtx) {
                        compCtx.fillStyle = 'black';
                        compCtx.fillRect(0, 0, dw, dh);
                        if (videoRef.current && videoRef.current.readyState >= 2) {
                            compCtx.drawImage(videoRef.current, 0, 0, dw, dh);
                        }
                        compCtx.drawImage(overlayRef.current!, 0, 0, dw, dh);
                    }
                    requestAnimationFrame(animLoop);
                };
                animLoop();

            } catch (err) {
                console.error("Live clip capture error:", err);
                mediaRecorderRef.current = null;
            }
        }
    }, [stream.id]);
    const drawDetRef = useRef(drawDetections);
    drawDetRef.current = drawDetections;

    /* ================================================================== */
    /*  PROVIDER EFFECT — client_cam owner only                            */
    /*  1. Captures camera (video + audio)                                 */
    /*  2. Creates PeerJS peer and registers peer ID with backend          */
    /*  3. Answers incoming calls from viewers with local MediaStream      */
    /*  4. Sends JPEG frames to backend via WS for AI inference only       */
    /* ================================================================== */
    useEffect(() => {
        if (!isClientCam || !isOwner) return;
        let alive = true;
        const wsUrl = getWsUrl();
        const baseUrl = getBaseUrl();
        let ws: WebSocket | null = null;
        let captureTimer: ReturnType<typeof setInterval> | null = null;
        let peer: Peer | null = null;

        async function start() {
            if (!alive) return;
            setNetState("starting_camera");
            try {
                const media = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
                    audio: true, // Capture audio for WebRTC
                });
                if (!alive) { media.getTracks().forEach(t => t.stop()); return; }
                localStreamRef.current = media;
                if (videoRef.current) {
                    videoRef.current.srcObject = media;
                    videoRef.current.muted = true; // Mute local preview to avoid echo
                    videoRef.current.play().catch(() => { });
                    setVideoLoaded(true);
                }
                setIsStreaming(true);
                setNetState("connecting_peer");

                // 1. Setup PeerJS
                setupPeer(media);

                // 2. Connect WS to send AI frames
                connectProviderWs();
            } catch (err) {
                console.error("[Provider] Camera error:", err);
                // Fallback: try video only if audio fails
                try {
                    const media = await navigator.mediaDevices.getUserMedia({
                        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
                        audio: false,
                    });
                    if (!alive) { media.getTracks().forEach(t => t.stop()); return; }
                    localStreamRef.current = media;
                    if (videoRef.current) {
                        videoRef.current.srcObject = media;
                        videoRef.current.muted = true;
                        videoRef.current.play().catch(() => { });
                        setVideoLoaded(true);
                    }
                    setIsStreaming(true);
                    setNetState("connecting_peer");
                    setupPeer(media);
                    connectProviderWs();
                } catch (err2) {
                    console.error("[Provider] Camera error (no audio fallback):", err2);
                    setNetState("camera_error");
                }
            }
        }

        function setupPeer(media: MediaStream) {
            if (!alive) return;
            const peerId = makePeerId(stream.id, "provider");
            const peerConfig = getPeerConfig();
            peer = new Peer(peerId, peerConfig);
            peerRef.current = peer;

            peer.on("open", (id) => {
                if (!alive) return;
                console.log(`[Provider] PeerJS connected with ID: ${id}`);
                setNetState("broadcasting");

                // Register peer ID with backend
                fetch(`${baseUrl}/api/streams/${stream.id}/provider`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ peer_id: id }),
                }).catch(err => console.error("[Provider] Failed to register peer:", err));
            });

            // Answer incoming calls from viewers
            peer.on("call", (call: MediaConnection) => {
                if (!alive) return;
                console.log(`[Provider] Answering call from viewer: ${call.peer}`);
                call.answer(media);
                activeCallsRef.current.add(call);

                call.on("close", () => {
                    activeCallsRef.current.delete(call);
                    console.log(`[Provider] Viewer disconnected: ${call.peer}`);
                });
                call.on("error", (err) => {
                    activeCallsRef.current.delete(call);
                    console.error(`[Provider] Call error with ${call.peer}:`, err);
                });
            });

            peer.on("error", (err) => {
                console.error("[Provider] PeerJS error:", err);
                if (alive && err.type !== "peer-unavailable") {
                    setNetState("peer_error");
                    // Auto-reconnect on fatal errors
                    setTimeout(() => {
                        if (alive && localStreamRef.current) {
                            peer?.destroy();
                            setupPeer(localStreamRef.current);
                        }
                    }, 3000);
                }
            });

            peer.on("disconnected", () => {
                if (alive) {
                    console.log("[Provider] PeerJS disconnected, reconnecting...");
                    peer?.reconnect();
                }
            });
        }

        function connectProviderWs() {
            if (!alive) return;
            ws = new WebSocket(`${wsUrl}/ws/stream_in/${stream.id}`);
            ws.binaryType = "arraybuffer";
            providerWsRef.current = ws;

            // Use OffscreenCanvas for faster, off-main-thread JPEG encoding
            let osc: OffscreenCanvas | null = null;
            let oscCtx: OffscreenCanvasRenderingContext2D | null = null;
            let sending = false;

            ws.onopen = () => {
                if (!alive) return;
                // Send frames at ~5 FPS for AI (reduced from 10fps since video is via WebRTC now)
                captureTimer = setInterval(async () => {
                    if (!alive || !ws || ws.readyState !== WebSocket.OPEN) return;
                    if (!videoRef.current || videoRef.current.readyState < 2 || sending) return;
                    // Backpressure: skip frame if socket buffer is congested (>64KB queued)
                    if (ws.bufferedAmount > 65536) return;
                    const vw = videoRef.current.videoWidth;
                    const vh = videoRef.current.videoHeight;
                    if (!vw || !vh) return;

                    const tw = 640;
                    const sc = tw / vw;
                    const th = Math.round(vh * sc);

                    if (!osc || osc.width !== tw || osc.height !== th) {
                        osc = new OffscreenCanvas(tw, th);
                        oscCtx = osc.getContext("2d");
                    }
                    if (!oscCtx) return;
                    oscCtx.drawImage(videoRef.current, 0, 0, tw, th);

                    sending = true;
                    try {
                        const blob = await osc.convertToBlob({ type: "image/jpeg", quality: 0.55 });
                        sending = false;
                        if (!blob || !ws || ws.readyState !== WebSocket.OPEN) return;
                        ws.send(blob);
                    } catch {
                        sending = false;
                    }
                }, 200); // 5 FPS for AI inference
            };

            ws.onclose = () => {
                if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
                if (alive) {
                    setNetState("reconnecting_ws");
                    setTimeout(connectProviderWs, 2000);
                }
            };
            ws.onerror = () => { /* let onclose handle it */ };
        }

        start();
        return () => {
            alive = false;
            if (captureTimer) clearInterval(captureTimer);
            if (ws) { ws.close(); ws = null; }
            providerWsRef.current = null;
            // Close all active WebRTC calls
            activeCallsRef.current.forEach(call => {
                try { call.close(); } catch { /* ignore */ }
            });
            activeCallsRef.current.clear();
            // Destroy PeerJS
            if (peer) {
                try { peer.destroy(); } catch { /* ignore */ }
            }
            peerRef.current = null;
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(t => t.stop());
                localStreamRef.current = null;
            }
        };
    }, [isClientCam, isOwner, stream.id]); // eslint-disable-line react-hooks/exhaustive-deps

    /* ================================================================== */
    /*  VIEWER EFFECT — everyone except the provider                       */
    /*  1. Fetches provider peer ID from backend                           */
    /*  2. Creates PeerJS peer and calls the provider                      */
    /*  3. Receives MediaStream via WebRTC and attaches to <video>         */
    /* ================================================================== */
    useEffect(() => {
        if (isClientCam && isOwner) return;

        let alive = true;
        const baseUrl = getBaseUrl();
        let peer: Peer | null = null;
        let currentCall: MediaConnection | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;

        async function connectViewer() {
            if (!alive) return;
            setNetState("waiting_for_provider");

            // Poll for provider peer ID
            async function fetchProviderPeerId(): Promise<string> {
                try {
                    const res = await fetch(`${baseUrl}/api/streams/${stream.id}/provider`);
                    const data = await res.json();
                    return data.peer_id || "";
                } catch {
                    return "";
                }
            }

            // Wait for the provider to register their peer ID
            let providerPeerId = "";
            const tryConnect = async () => {
                if (!alive) return;
                providerPeerId = await fetchProviderPeerId();
                if (!providerPeerId) {
                    // Provider not ready yet, wait and retry
                    if (alive) {
                        pollTimer = setTimeout(tryConnect, 2000);
                    }
                    return;
                }
                // Provider available, establish WebRTC connection
                setNetState("connecting_peer");
                setupViewerPeer(providerPeerId);
            };

            tryConnect();
        }

        function setupViewerPeer(providerPeerId: string) {
            if (!alive) return;

            const viewerPeerId = makePeerId(stream.id, "viewer");
            const peerConfig = getPeerConfig();
            peer = new Peer(viewerPeerId, peerConfig);
            peerRef.current = peer;

            peer.on("open", () => {
                if (!alive) return;
                console.log(`[Viewer] PeerJS connected, calling provider: ${providerPeerId}`);
                setNetState("calling_provider");

                // Call the provider to get their MediaStream
                currentCall = peer!.call(providerPeerId, new MediaStream(), {
                    // We send an empty stream — we just want to receive
                });

                if (!currentCall) {
                    console.error("[Viewer] Failed to create call");
                    setNetState("call_failed");
                    return;
                }

                currentCall.on("stream", (remoteStream: MediaStream) => {
                    if (!alive) return;
                    console.log("[Viewer] Received remote stream via WebRTC");
                    setIsStreaming(true);
                    setNetState("streaming");

                    if (videoRef.current) {
                        videoRef.current.srcObject = remoteStream;
                        videoRef.current.muted = isMuted;
                        videoRef.current.play().then(() => {
                            setVideoLoaded(true);
                        }).catch(() => {
                            // Autoplay blocked — show play button
                            setShowPlayButton(true);
                            setVideoLoaded(true);
                        });
                    }
                });

                currentCall.on("close", () => {
                    console.log("[Viewer] Call closed, reconnecting...");
                    setIsStreaming(false);
                    if (alive) {
                        // Cleanup and retry
                        peer?.destroy();
                        peerRef.current = null;
                        setTimeout(() => connectViewer(), 3000);
                    }
                });

                currentCall.on("error", (err) => {
                    console.error("[Viewer] Call error:", err);
                    setIsStreaming(false);
                    if (alive) {
                        peer?.destroy();
                        peerRef.current = null;
                        setTimeout(() => connectViewer(), 3000);
                    }
                });
            });

            peer.on("error", (err) => {
                console.error("[Viewer] PeerJS error:", err);
                if (alive && err.type === "peer-unavailable") {
                    // Provider peer not found — retry
                    console.log("[Viewer] Provider peer unavailable, retrying...");
                    setNetState("waiting_for_provider");
                    peer?.destroy();
                    peerRef.current = null;
                    setTimeout(() => connectViewer(), 3000);
                } else if (alive) {
                    setNetState("peer_error");
                    peer?.destroy();
                    peerRef.current = null;
                    setTimeout(() => connectViewer(), 5000);
                }
            });

            peer.on("disconnected", () => {
                if (alive) {
                    console.log("[Viewer] PeerJS disconnected, reconnecting...");
                    peer?.reconnect();
                }
            });
        }

        connectViewer();
        return () => {
            alive = false;
            if (pollTimer) clearTimeout(pollTimer);
            if (currentCall) {
                try { currentCall.close(); } catch { /* ignore */ }
            }
            if (peer) {
                try { peer.destroy(); } catch { /* ignore */ }
            }
            peerRef.current = null;
        };
    }, [isClientCam, isOwner, stream.id]); // eslint-disable-line react-hooks/exhaustive-deps

    /* ================================================================== */
    /*  DETECTION OVERLAY EFFECT — all clients (provider + viewers)         */
    /*  Subscribes to stream_out for detection text JSON only               */
    /* ================================================================== */
    useEffect(() => {
        let alive = true;
        const wsUrl = getWsUrl();
        let ws: WebSocket | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        function connect() {
            if (!alive) return;
            ws = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
            ws.binaryType = "blob";

            ws.onopen = () => {
                pingTimer = setInterval(() => {
                    if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
                }, 20000);
            };
            ws.onmessage = (evt) => {
                if (typeof evt.data === "string") {
                    try {
                        const d = JSON.parse(evt.data);
                        if (d.detections) {
                            requestAnimationFrame(() => drawDetRef.current(d.detections));
                            onDetectionsRef.current(d.detections, d.timestamp);
                        }
                    } catch { /* skip */ }
                }
                // Ignore any binary messages (shouldn't arrive anymore)
            };
            ws.onclose = () => {
                if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
                if (alive) setTimeout(connect, 3000);
            };
        }
        connect();
        return () => {
            alive = false;
            if (pingTimer) clearInterval(pingTimer);
            if (ws) ws.close();
        };
    }, [stream.id]); // eslint-disable-line react-hooks/exhaustive-deps

    /* ---- mute/unmute handler ---- */
    const toggleMute = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsMuted(prev => {
            const newVal = !prev;
            if (videoRef.current) videoRef.current.muted = newVal;
            return newVal;
        });
    }, []);

    /* ---- delete ---- */
    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!window.confirm(`Terminate ${stream.name}?`)) return;
        if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
        if (providerWsRef.current) providerWsRef.current.close();
        // Close all WebRTC connections
        activeCallsRef.current.forEach(call => {
            try { call.close(); } catch { /* ignore */ }
        });
        activeCallsRef.current.clear();
        if (peerRef.current) {
            try { peerRef.current.destroy(); } catch { /* ignore */ }
            peerRef.current = null;
        }
        onDelete(stream.id, true);
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
                    <span className={`bg-black px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] ${isStreaming ? 'text-[var(--color-alert)] animate-pulse' : 'text-[#333]'}`}>
                        {isStreaming ? 'REC' : 'WAITING'}
                    </span>
                    {/* Mute/Unmute button — visible for viewers */}
                    {!isOwner && (
                        <button onClick={toggleMute} className="bg-black text-[var(--color-iron)] hover:text-[var(--color-data)] hover:border-[var(--color-data)] border border-[var(--color-iron)] px-1" title={isMuted ? "Unmute" : "Mute"}>
                            {isMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                        </button>
                    )}
                    <button onClick={handleDelete} className="bg-black text-[var(--color-iron)] hover:text-red-500 hover:border-red-500 border border-[var(--color-iron)] px-1">
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {/* Video area */}
            <div className="relative flex-1 w-full h-full flex items-center justify-center overflow-hidden">
                {/* Loading spinner */}
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
                                <span className="w-48 text-center uppercase tracking-[0.3em]">{netState.replace(/_/g, " ")}</span>
                                <span>]</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Unified video element for all cases (provider & viewer) */}
                <video
                    ref={videoRef}
                    className="absolute inset-0 h-full w-full object-cover z-10"
                    style={{ transform: "translateZ(0)" }}
                    autoPlay={true}
                    playsInline={true}
                    muted={isOwner ? true : isMuted}
                />

                {/* Detection overlay */}
                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />

                {/* Mobile play button */}
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