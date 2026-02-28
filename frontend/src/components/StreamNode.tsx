"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Trash2, Volume2, VolumeX, Play } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";

/* ------------------------------------------------------------------ */
/*  ICE servers — STUN for discovery + free TURN for NAT traversal     */
/* ------------------------------------------------------------------ */
const ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Free Metered TURN servers — relay for symmetric NAT
    {
        urls: "turn:standard.relay.metered.ca:80",
        username: "b482f94546e12054e22a1a51",
        credential: "JHMWBatNsLGJXsfe",
    },
    {
        urls: "turn:standard.relay.metered.ca:443",
        username: "b482f94546e12054e22a1a51",
        credential: "JHMWBatNsLGJXsfe",
    },
    {
        urls: "turn:standard.relay.metered.ca:443?transport=tcp",
        username: "b482f94546e12054e22a1a51",
        credential: "JHMWBatNsLGJXsfe",
    },
];

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
    const overlayRef = useRef<HTMLCanvasElement>(null);

    // Keep track of the remote MediaStream for viewers
    const remoteStreamRef = useRef<MediaStream>(new MediaStream());
    // Keep track of the local media stream for providers (for cleanup)
    const localStreamRef = useRef<MediaStream | null>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const signalWsRef = useRef<WebSocket | null>(null);
    const aiWsRef = useRef<WebSocket | null>(null);

    const [isStreaming, setIsStreaming] = useState(false);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isMuted, setIsMuted] = useState(true);
    const [showPlayButton, setShowPlayButton] = useState(false);
    const [wsState, setWsState] = useState<string>("init");

    // Determine device identity
    const [localDeviceId, setLocalDeviceId] = useState("");
    useEffect(() => {
        let id = localStorage.getItem("device_id");
        if (!id) {
            id = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", id);
        }
        setLocalDeviceId(id);
    }, []);

    const isOwner = stream.type === "client_cam" && stream.device_id === localDeviceId;
    const isClientCam = stream.type === "client_cam";

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

    /* ------------------------------------------------------------------ */
    /*  Detection WS (receive AI results from backend)                     */
    /* ------------------------------------------------------------------ */
    useEffect(() => {
        let active = true;
        const wsUrl = getWsUrl();
        let detWs: WebSocket | null = null;
        let pingInterval: ReturnType<typeof setInterval> | null = null;

        const connectDetWs = () => {
            if (!active) return;
            detWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
            detWs.onopen = () => {
                pingInterval = setInterval(() => {
                    if (detWs?.readyState === WebSocket.OPEN) {
                        detWs.send(JSON.stringify({ type: "ping", ts: Date.now() }));
                    }
                }, 15000);
            };
            detWs.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.detections) {
                        requestAnimationFrame(() => drawDetections(data.detections));
                        onDetections(data.detections, data.timestamp);
                    }
                } catch { /* ignore */ }
            };
            detWs.onclose = () => {
                if (active) setTimeout(connectDetWs, 3000);
            };
        };
        connectDetWs();
        return () => {
            active = false;
            if (pingInterval) clearInterval(pingInterval);
            if (detWs) detWs.close();
        };
    }, [stream.id, drawDetections, onDetections]);

    /* ------------------------------------------------------------------ */
    /*  Attach remoteStreamRef to video element once it mounts             */
    /* ------------------------------------------------------------------ */
    useEffect(() => {
        if (videoRef.current && remoteStreamRef.current) {
            videoRef.current.srcObject = remoteStreamRef.current;
        }
    });

    /* ------------------------------------------------------------------ */
    /*  Boost sender bitrate for crisp video                               */
    /* ------------------------------------------------------------------ */
    const boostBitrate = useCallback(async (pc: RTCPeerConnection) => {
        const senders = pc.getSenders();
        for (const sender of senders) {
            if (sender.track?.kind !== "video") continue;
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 2_500_000; // 2.5 Mbps
            try {
                await sender.setParameters(params);
            } catch (e) {
                console.warn("[WebRTC] Failed to set bitrate:", e);
            }
        }
    }, []);

    /* ------------------------------------------------------------------ */
    /*  WebRTC for client_cam streams                                      */
    /* ------------------------------------------------------------------ */
    useEffect(() => {
        if (!isClientCam || !localDeviceId) return;

        let active = true;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        const wsUrl = getWsUrl();
        const peerId = `${localDeviceId}_${Math.random().toString(36).slice(2, 8)}`;

        const cleanup = () => {
            active = false;
            if (reconnectTimer) clearTimeout(reconnectTimer);

            // Close AI WS
            if (aiWsRef.current) {
                aiWsRef.current.close();
                aiWsRef.current = null;
            }

            // Stop local media tracks
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach((t) => t.stop());
                localStreamRef.current = null;
            }

            // Close peer connection
            if (pcRef.current) {
                pcRef.current.close();
                pcRef.current = null;
            }

            // Close signaling WS
            if (signalWsRef.current) {
                signalWsRef.current.close();
                signalWsRef.current = null;
            }
        };

        /* =================== PROVIDER PATH =================== */
        const startProvider = async () => {
            if (!active) return;
            setWsState("checking");

            // 1 — Get local camera + mic
            let localStream: MediaStream;
            try {
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30 },
                    },
                    audio: true,
                });
            } catch (err) {
                console.error("[Provider] getUserMedia failed:", err);
                setWsState("error");
                return;
            }
            if (!active) { localStream.getTracks().forEach((t) => t.stop()); return; }

            localStreamRef.current = localStream;

            // Show local preview
            if (videoRef.current) {
                videoRef.current.srcObject = localStream;
                videoRef.current.muted = true;
                videoRef.current.play().catch(() => { });
                setVideoLoaded(true);
            }
            setIsStreaming(true);

            // 2 — Connect signaling WS
            const ws = new WebSocket(`${wsUrl}/ws/signal/${stream.id}`);
            signalWsRef.current = ws;

            // Track peer connections per viewer
            const viewerPCs: Map<string, RTCPeerConnection> = new Map();

            ws.onopen = () => {
                setWsState("connected");
                ws.send(JSON.stringify({ type: "provider-ready" }));
            };

            ws.onmessage = async (event) => {
                if (!active) return;
                const msg = JSON.parse(event.data);

                if (msg.type === "viewer-joined") {
                    // Create a new peer connection for this viewer
                    const viewerId = msg.peerId;
                    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
                    viewerPCs.set(viewerId, pc);

                    // Add all local tracks
                    localStream.getTracks().forEach((track) => {
                        pc.addTrack(track, localStream);
                    });

                    // ICE candidates → send to viewer
                    pc.onicecandidate = (e) => {
                        if (e.candidate && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: "ice-candidate",
                                peerId: viewerId,
                                candidate: {
                                    candidate: e.candidate.candidate,
                                    sdpMid: e.candidate.sdpMid,
                                    sdpMLineIndex: e.candidate.sdpMLineIndex,
                                },
                            }));
                        }
                    };

                    pc.oniceconnectionstatechange = () => {
                        if (pc.iceConnectionState === "connected") {
                            boostBitrate(pc);
                        }
                    };

                    // Create offer and send
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        ws.send(JSON.stringify({
                            type: "offer",
                            peerId: viewerId,
                            sdp: offer.sdp,
                        }));
                    } catch (err) {
                        console.error("[Provider] Offer creation failed:", err);
                    }
                }

                else if (msg.type === "answer") {
                    const pc = viewerPCs.get(msg.peerId);
                    if (pc && pc.signalingState === "have-local-offer") {
                        try {
                            await pc.setRemoteDescription(new RTCSessionDescription({
                                type: "answer",
                                sdp: msg.sdp,
                            }));
                        } catch (err) {
                            console.error("[Provider] setRemoteDescription failed:", err);
                        }
                    }
                }

                else if (msg.type === "ice-candidate" && msg.candidate) {
                    const pc = viewerPCs.get(msg.peerId);
                    if (pc) {
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } catch (err) {
                            console.error("[Provider] addIceCandidate failed:", err);
                        }
                    }
                }

                else if (msg.type === "viewer-left") {
                    const pc = viewerPCs.get(msg.peerId);
                    if (pc) {
                        pc.close();
                        viewerPCs.delete(msg.peerId);
                    }
                }
            };

            ws.onclose = () => {
                if (active) {
                    setWsState("reconnecting");
                    reconnectTimer = setTimeout(startProvider, 3000);
                }
            };

            ws.onerror = () => {
                console.error("[Provider] Signal WS error");
            };

            // 3 — AI frame capture (canvas grab → /ws/stream_in)
            const startAiCapture = () => {
                if (!active) return;
                const aiWs = new WebSocket(`${wsUrl}/ws/stream_in/${stream.id}`);
                aiWsRef.current = aiWs;
                let sending = false;
                let captureInterval: ReturnType<typeof setInterval> | null = null;

                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d", { willReadFrequently: false });

                aiWs.onopen = () => {
                    captureInterval = setInterval(() => {
                        if (!active || aiWs.readyState !== WebSocket.OPEN || !videoRef.current) return;
                        if (videoRef.current.readyState < 2 || sending) return;

                        const vw = videoRef.current.videoWidth;
                        const vh = videoRef.current.videoHeight;
                        if (!vw || !vh) return;

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
                                const reader = new FileReader();
                                reader.onloadend = () => {
                                    if (typeof reader.result === "string") {
                                        aiWs.send(JSON.stringify({ type: "frame", frame: reader.result }));
                                    }
                                };
                                reader.readAsDataURL(blob);
                            },
                            "image/jpeg",
                            0.55,
                        );
                    }, 125); // ~8 FPS
                };

                aiWs.onclose = () => {
                    if (captureInterval) clearInterval(captureInterval);
                    captureInterval = null;
                    if (active) setTimeout(startAiCapture, 3000);
                };
            };
            startAiCapture();
        };

        /* =================== VIEWER PATH =================== */
        const startViewer = () => {
            if (!active) return;
            setWsState("checking");

            const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            pcRef.current = pc;

            // Receive remote tracks
            pc.ontrack = (event) => {
                console.log("[Viewer] Got remote track:", event.track.kind);
                remoteStreamRef.current.addTrack(event.track);

                // Attach to video element immediately
                if (videoRef.current) {
                    videoRef.current.srcObject = remoteStreamRef.current;
                    videoRef.current.play().catch(() => setShowPlayButton(true));
                    setVideoLoaded(true);
                }
                setIsStreaming(true);
            };

            // Connect signaling
            const ws = new WebSocket(`${wsUrl}/ws/signal/${stream.id}`);
            signalWsRef.current = ws;

            ws.onopen = () => {
                setWsState("connected");
                ws.send(JSON.stringify({ type: "viewer-join", peerId }));
            };

            ws.onmessage = async (event) => {
                if (!active) return;
                const msg = JSON.parse(event.data);

                if (msg.type === "offer") {
                    try {
                        await pc.setRemoteDescription(new RTCSessionDescription({
                            type: "offer",
                            sdp: msg.sdp,
                        }));
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        ws.send(JSON.stringify({
                            type: "answer",
                            peerId,
                            sdp: answer.sdp,
                        }));
                    } catch (err) {
                        console.error("[Viewer] SDP negotiation failed:", err);
                    }
                }

                else if (msg.type === "ice-candidate" && msg.candidate) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                    } catch (err) {
                        console.error("[Viewer] addIceCandidate failed:", err);
                    }
                }
            };

            // ICE candidates → send to provider
            pc.onicecandidate = (e) => {
                if (e.candidate && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: "ice-candidate",
                        peerId,
                        candidate: {
                            candidate: e.candidate.candidate,
                            sdpMid: e.candidate.sdpMid,
                            sdpMLineIndex: e.candidate.sdpMLineIndex,
                        },
                    }));
                }
            };

            // ICE connection state monitoring + auto-restart
            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                console.log("[Viewer] ICE state:", state);
                if (state === "failed") {
                    console.warn("[Viewer] ICE failed, will reconnect...");
                    pc.close();
                    pcRef.current = null;
                    remoteStreamRef.current = new MediaStream();
                    setVideoLoaded(false);
                    setIsStreaming(false);
                    if (active) {
                        reconnectTimer = setTimeout(startViewer, 2000);
                    }
                } else if (state === "disconnected") {
                    // Wait a bit for recovery before reconnecting
                    setTimeout(() => {
                        if (pc.iceConnectionState === "disconnected" && active) {
                            console.warn("[Viewer] ICE still disconnected, reconnecting...");
                            pc.close();
                            pcRef.current = null;
                            remoteStreamRef.current = new MediaStream();
                            setVideoLoaded(false);
                            setIsStreaming(false);
                            reconnectTimer = setTimeout(startViewer, 2000);
                        }
                    }, 5000);
                }
            };

            ws.onclose = () => {
                if (active) {
                    setWsState("reconnecting");
                    reconnectTimer = setTimeout(startViewer, 3000);
                }
            };

            ws.onerror = () => {
                console.error("[Viewer] Signal WS error");
            };
        };

        // Start appropriate path
        if (isOwner) {
            startProvider();
        } else {
            startViewer();
        }

        return cleanup;
    }, [isClientCam, isOwner, localDeviceId, stream.id, boostBitrate]);

    /* ------------------------------------------------------------------ */
    /*  Audio mute control                                                 */
    /* ------------------------------------------------------------------ */
    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.muted = isOwner ? true : isMuted;
        }
    }, [isMuted, isOwner]);

    /* ------------------------------------------------------------------ */
    /*  Delete handler                                                     */
    /* ------------------------------------------------------------------ */
    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const confirmed = window.confirm(`Terminate ${stream.name}? This removes it for all users.`);
        if (confirmed) {
            // Cleanup WebRTC + WS before delete
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach((t) => t.stop());
            }
            if (pcRef.current) pcRef.current.close();
            if (signalWsRef.current) signalWsRef.current.close();
            if (aiWsRef.current) aiWsRef.current.close();
            onDelete(stream.id, true);
        }
    };

    /* ================================================================== */
    /*  Fallback for server_cam / rtsp: render frames from WS              */
    /* ================================================================== */
    const imgRef = useRef<HTMLImageElement>(null);
    useEffect(() => {
        if (isClientCam) return; // handled by WebRTC above

        let active = true;
        const wsUrl = getWsUrl();
        let fbWs: WebSocket | null = null;
        let pingInterval: ReturnType<typeof setInterval> | null = null;

        const connect = () => {
            if (!active) return;
            setWsState("checking");
            fbWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
            fbWs.onopen = () => {
                setWsState("connected");
                setIsStreaming(true);
                pingInterval = setInterval(() => {
                    if (fbWs?.readyState === WebSocket.OPEN) {
                        fbWs.send(JSON.stringify({ type: "ping", ts: Date.now() }));
                    }
                }, 15000);
            };
            fbWs.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "frame" && imgRef.current) {
                        imgRef.current.src = "data:image/jpeg;base64," + data.frame;
                        if (!videoLoaded) setVideoLoaded(true);
                    }
                    if (data.detections) {
                        requestAnimationFrame(() => drawDetections(data.detections));
                        onDetections(data.detections, data.timestamp);
                    }
                } catch { /* ignore */ }
            };
            fbWs.onclose = () => {
                setIsStreaming(false);
                setVideoLoaded(false);
                if (active) setTimeout(connect, 3000);
            };
        };
        connect();
        return () => {
            active = false;
            if (pingInterval) clearInterval(pingInterval);
            if (fbWs) fbWs.close();
        };
    }, [isClientCam, stream.id, drawDetections, onDetections, videoLoaded]);

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
            <div className={`p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent ${!isPrimary && "bg-black border-b-[2px] border-[var(--color-iron)]"} absolute top-0 left-0 w-full`}>
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[150px]`}>
                    {stream.name} [{stream.type.toUpperCase()}]
                </span>
                <div className="flex gap-2">
                    {/* Audio mute toggle */}
                    {isClientCam && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setIsMuted(!isMuted);
                            }}
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
                                <span className="w-48 text-center uppercase tracking-[0.3em]">
                                    {wsState === "checking" ? "CONNECTING"
                                        : wsState === "connected" && !videoLoaded ? "NEGOTIATING P2P"
                                            : wsState === "reconnecting" ? "RECONNECTING"
                                                : "AWAITING FEED"}
                                </span>
                                <span>]</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Video element for WebRTC (client_cam) */}
                {isClientCam && (
                    <video
                        ref={videoRef}
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        style={{ transform: "translateZ(0)" }}
                        autoPlay
                        muted={isOwner ? true : isMuted}
                        playsInline
                    />
                )}

                {/* Image element for fallback WS (server_cam / rtsp) */}
                {!isClientCam && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        ref={imgRef}
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        alt="Stream"
                    />
                )}

                {/* Detection overlay canvas */}
                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />

                {/* Manual play button (mobile autoplay restriction) */}
                {showPlayButton && (
                    <div
                        className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 cursor-pointer"
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowPlayButton(false);
                            videoRef.current?.play().catch(() => { });
                        }}
                    >
                        <div className="w-16 h-16 rounded-full bg-white/20 border-2 border-white flex items-center justify-center backdrop-blur-sm">
                            <Play className="w-8 h-8 text-white ml-1" fill="white" />
                        </div>
                        <span className="absolute bottom-4 text-[10px] font-mono font-bold text-white/80 tracking-widest">
                            TAP TO START FEED
                        </span>
                    </div>
                )}
            </div>
        </motion.div>
    );
}
