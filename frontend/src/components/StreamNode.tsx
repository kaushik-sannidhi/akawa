"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Trash2, Volume2, VolumeX, Play } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";

/* ------------------------------------------------------------------ */
/*  STUN + TURN servers for reliable NAT traversal across networks     */
/* ------------------------------------------------------------------ */
const ICE_SERVERS: RTCConfiguration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        // Free TURN relays — ensures connectivity across different networks / mobile NATs
        {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject",
        },
        {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject",
        },
        {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject",
        },
    ],
    iceCandidatePoolSize: 5,
};

/** Apply low-latency tuning to an RTCPeerConnection's video sender. */
function tuneVideoSender(pc: RTCPeerConnection) {
    for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 1_500_000;            // 1.5 Mbps cap — good balance
        params.degradationPreference = "maintain-framerate";    // Prefer FPS over resolution
        sender.setParameters(params).catch(() => {});
    }
}

/**
 * Prefer H.264 in an SDP offer/answer so Safari (which only supports H.264 hardware
 * decode) works reliably.  If no H.264 payload type is found the SDP is returned
 * unchanged.
 */
function preferH264(sdp: string): string {
    const lines = sdp.split("\r\n");
    const mVideoIdx = lines.findIndex(l => l.startsWith("m=video"));
    if (mVideoIdx === -1) return sdp;

    // Collect H.264 payload type numbers from rtpmap lines
    const h264PTs: string[] = [];
    for (const line of lines) {
        const match = line.match(/^a=rtpmap:(\d+)\s+H264\//i);
        if (match) h264PTs.push(match[1]);
    }
    if (h264PTs.length === 0) return sdp; // No H.264 — leave SDP as-is

    // Reorder the m=video line: move H.264 payload types to front
    const parts = lines[mVideoIdx].split(" ");
    // parts[0]="m=video", [1]=port, [2]=proto, [3..]=payload types
    const existingPTs = parts.slice(3);
    const nonH264PTs = existingPTs.filter(pt => !h264PTs.includes(pt));
    lines[mVideoIdx] = [...parts.slice(0, 3), ...h264PTs, ...nonH264PTs].join(" ");

    return lines.join("\r\n");
}

interface StreamNodeProps {
    stream: any;
    onDelete: (id: string, cascadeDelete: boolean) => void;
    onDetections: (detections: any[], timestamp: number) => void;
    onSelect?: () => void;
    isPrimary?: boolean;
}

export default function StreamNode({ stream, onDelete, onDetections, onSelect, isPrimary = false }: StreamNodeProps) {
    const localVideoRef = useRef<HTMLVideoElement>(null);   // Camera owner's local preview
    const remoteVideoRef = useRef<HTMLVideoElement>(null);   // Viewer's WebRTC remote video
    const imgRef = useRef<HTMLImageElement>(null);           // Fallback for server_cam / rtsp
    const overlayRef = useRef<HTMLCanvasElement>(null);

    const [isStreaming, setIsStreaming] = useState(false);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [wsState, setWsState] = useState<string>("init");
    const [isMuted, setIsMuted] = useState(true);  // Start muted — user can unmute
    const [showPlayButton, setShowPlayButton] = useState(false);
    const streamingRef = useRef(false);

    const [hasMounted, setHasMounted] = useState(false);
    const [localDeviceId, setLocalDeviceId] = useState("pending");

    // WebRTC peer connections keyed by peerId (provider keeps one per viewer)
    const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
    const localStreamRef = useRef<MediaStream | null>(null);

    useEffect(() => {
        let id = localStorage.getItem("device_id");
        if (!id) {
            id = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", id);
        }
        setLocalDeviceId(id);
        setHasMounted(true);
    }, []);

    const isOwnerOfClientCam = stream.type === "client_cam" && stream.device_id === localDeviceId;
    const isClientCam = stream.type === "client_cam";

    /* ------------------------------------------------------------------ */
    /*  Cleanup helpers                                                    */
    /* ------------------------------------------------------------------ */
    const cleanupPeerConnections = useCallback(() => {
        peerConnectionsRef.current.forEach((pc) => pc.close());
        peerConnectionsRef.current.clear();
    }, []);

    /** Safely play a video element — shows play button on mobile if autoplay blocked */
    const safePlay = useCallback((video: HTMLVideoElement) => {
        if (!video) return;
        // Force inline playback attributes for iOS
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "");
        // Must be muted for autoplay to work on mobile
        video.muted = true;

        const playPromise = video.play();
        if (playPromise !== undefined) {
            playPromise
                .then(() => {
                    // Autoplay worked — hide play button if it was showing
                    setShowPlayButton(false);
                })
                .catch(() => {
                    // Autoplay blocked (common on mobile) — show manual play button
                    setShowPlayButton(true);
                });
        }
    }, []);

    /** Handle user tapping the play button overlay */
    const handleManualPlay = useCallback(() => {
        setShowPlayButton(false);

        const video = isOwnerOfClientCam ? localVideoRef.current : remoteVideoRef.current;
        if (!video) return;

        video.playsInline = true;
        video.muted = true;

        // On mobile Safari, re-assigning srcObject can kick the decoder
        if (!isOwnerOfClientCam) {
            // Viewer side — rebuild the stream from all receiver tracks (audio + video)
            const pc = peerConnectionsRef.current.get("provider");
            if (pc) {
                const receivers = pc.getReceivers();
                if (receivers.length > 0) {
                    const stream = new MediaStream();
                    receivers.forEach(r => { if (r.track) stream.addTrack(r.track); });
                    video.srcObject = stream;
                }
            }
        }

        video.play().catch(() => {});
    }, [isOwnerOfClientCam]);

    const stopLocalStream = useCallback(() => {
        streamingRef.current = false;
        setIsStreaming(false);
        setVideoLoaded(false);

        if (localVideoRef.current && localVideoRef.current.srcObject) {
            (localVideoRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
            localVideoRef.current.srcObject = null;
        }
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
        }
        cleanupPeerConnections();
    }, [cleanupPeerConnections]);

    /* ------------------------------------------------------------------ */
    /*  Detection overlay drawing                                          */
    /* ------------------------------------------------------------------ */
    const drawDetections = useCallback((detections: any[]) => {
        if (!overlayRef.current) return;

        // Always use the CSS display size of the canvas container for the
        // internal buffer.  Using the native videoWidth/videoHeight caused
        // the canvas to scale on mobile — fixed-pixel labels became huge,
        // covering the video underneath and making it look like only AI
        // tracings were visible.
        const displayW = overlayRef.current.clientWidth  || 640;
        const displayH = overlayRef.current.clientHeight || 480;

        // Avoid expensive resize every frame — only touch the buffer when
        // the display size actually changed.
        if (overlayRef.current.width !== displayW || overlayRef.current.height !== displayH) {
            overlayRef.current.width  = displayW;
            overlayRef.current.height = displayH;
        }

        const ctx = overlayRef.current.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, displayW, displayH);

        // Scale label sizes relative to the container so they stay readable
        // on both 320 px phones and 1920 px desktops.
        const scale = Math.max(displayW / 1280, 0.4);   // min 40 %
        const lineW   = Math.max(2, 2 * scale);
        const fontSize = Math.round(Math.max(9, 10 * scale));
        const labelH   = Math.round(Math.max(14, 20 * scale));

        detections.forEach((det: any) => {
            if (det.confidence < 0.45) return;
            const bbox = det.bbox;
            const x1 = (bbox.x1 ?? bbox[0]) * displayW;
            const y1 = (bbox.y1 ?? bbox[1]) * displayH;
            const x2 = (bbox.x2 ?? bbox[2]) * displayW;
            const y2 = (bbox.y2 ?? bbox[3]) * displayH;
            const isWeapon = ["rifle", "handgun", "knife", "weapon"].includes(det.class_name);
            const color = isWeapon ? "#FF3300" : "#FFFFFF";

            // Corner brackets
            const corner = Math.max(6, 10 * scale);
            ctx.strokeStyle = color;
            ctx.lineWidth = lineW;
            ctx.beginPath();
            ctx.moveTo(x1, y1 + corner); ctx.lineTo(x1, y1); ctx.lineTo(x1 + corner, y1);
            ctx.moveTo(x2 - corner, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + corner);
            ctx.moveTo(x2, y2 - corner); ctx.lineTo(x2, y2); ctx.lineTo(x2 - corner, y2);
            ctx.moveTo(x1 + corner, y2); ctx.lineTo(x1, y2); ctx.lineTo(x1, y2 - corner);
            ctx.stroke();

            // Label background — semi-transparent so video shows through
            const text = `${det.class_name.toUpperCase()} ${(det.confidence * 100).toFixed(0)}%`;
            ctx.font = `bold ${fontSize}px monospace`;
            const tw = ctx.measureText(text).width + 8;
            ctx.fillStyle = isWeapon ? "rgba(255,51,0,0.75)" : "rgba(255,255,255,0.65)";
            ctx.fillRect(x1, y1 - labelH, tw, labelH);

            // Label text
            ctx.fillStyle = isWeapon ? "#FFFFFF" : "#000000";
            ctx.fillText(text, x1 + 4, y1 - (labelH * 0.25));
        });
    }, []);

    /* ================================================================== */
    /*  MAIN EFFECT — sets up all connections                              */
    /* ================================================================== */
    useEffect(() => {
        if (!hasMounted) return;
        let isActive = true;
        let signalWs: WebSocket | null = null;
        let aiWs: WebSocket | null = null;
        let detWs: WebSocket | null = null;
        let captureInterval: ReturnType<typeof setInterval>;
        let detPingInterval: ReturnType<typeof setInterval> | null = null;
        let reconnectTimeout: ReturnType<typeof setTimeout>;

        const wsUrl = getWsUrl();

        /* ============================================================== */
        /*  CAMERA PROVIDER PATH (isOwnerOfClientCam && client_cam)        */
        /* ============================================================== */
        const initProvider = async () => {
            if (!isActive) return;
            setWsState("checking");

            try {
                // 1. Get local camera
                const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
                const videoConstraints: MediaTrackConstraints = {
                    width: { ideal: isMobile ? 640 : 1280 },
                    height: { ideal: isMobile ? 480 : 720 },
                    frameRate: { ideal: isMobile ? 20 : 24, max: 30 },
                };
                if (stream.source && stream.source !== "local") {
                    videoConstraints.deviceId = { exact: stream.source };
                } else if (isMobile) {
                    // Default to environment (rear) camera on mobile
                    videoConstraints.facingMode = { ideal: "environment" };
                }
                const mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: videoConstraints,
                    audio: true,
                });
                if (!isActive) { mediaStream.getTracks().forEach((t) => t.stop()); return; }
                localStreamRef.current = mediaStream;

                // Start with mic muted (isMuted defaults to true) to avoid surprise audio
                mediaStream.getAudioTracks().forEach((t) => { t.enabled = false; });

                // Show local preview
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = mediaStream;
                    localVideoRef.current.muted = true;
                    safePlay(localVideoRef.current);
                }
                setVideoLoaded(true);

                // 2. Connect signaling WS
                signalWs = new WebSocket(`${wsUrl}/ws/signal/${stream.id}`);

                signalWs.onopen = () => {
                    setWsState("connected");
                    setIsStreaming(true);
                    streamingRef.current = true;
                    // Register as provider
                    signalWs!.send(JSON.stringify({ type: "provider-ready" }));
                };

                signalWs.onmessage = async (event) => {
                    const msg = JSON.parse(event.data);

                    if (msg.type === "viewer-joined") {
                        // Create a new RTCPeerConnection for this viewer
                        const peerId: string = msg.peerId;
                        console.log(`[WebRTC Provider] New viewer: ${peerId}`);
                        const pc = new RTCPeerConnection(ICE_SERVERS);
                        peerConnectionsRef.current.set(peerId, pc);

                        // Add local tracks
                        localStreamRef.current?.getTracks().forEach((track) => {
                            pc.addTrack(track, localStreamRef.current!);
                        });

                        // ICE candidates → signaling server
                        // Send null candidate too (end-of-candidates — needed by Safari)
                        pc.onicecandidate = (e) => {
                            if (signalWs?.readyState !== WebSocket.OPEN) return;
                            if (e.candidate) {
                                signalWs.send(JSON.stringify({
                                    type: "ice-candidate",
                                    peerId,
                                    candidate: e.candidate.toJSON(),
                                }));
                            } else {
                                // null candidate = end-of-candidates
                                signalWs.send(JSON.stringify({
                                    type: "ice-candidate",
                                    peerId,
                                    candidate: null,
                                }));
                            }
                        };

                        // Create & send offer — prefer H.264 for Safari compatibility
                        const offer = await pc.createOffer({
                            offerToReceiveAudio: false,
                            offerToReceiveVideo: false,
                        });
                        offer.sdp = preferH264(offer.sdp || "");
                        await pc.setLocalDescription(offer);

                        // Apply low-latency sender tuning once local description is set
                        tuneVideoSender(pc);

                        signalWs!.send(JSON.stringify({
                            type: "offer",
                            peerId,
                            sdp: pc.localDescription?.sdp,
                        }));
                    }

                    if (msg.type === "answer") {
                        const peerId: string = msg.peerId;
                        const pc = peerConnectionsRef.current.get(peerId);
                        if (pc && pc.signalingState !== "stable") {
                            await pc.setRemoteDescription(
                                new RTCSessionDescription({ type: "answer", sdp: msg.sdp })
                            );
                            console.log(`[WebRTC Provider] Answer set for viewer ${peerId}`);
                        }
                    }

                    if (msg.type === "ice-candidate" && msg.peerId) {
                        const pc = peerConnectionsRef.current.get(msg.peerId);
                        if (pc) {
                            if (msg.candidate) {
                                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
                            } else {
                                // null candidate = end-of-candidates signal
                                await pc.addIceCandidate(undefined as any).catch(() => {});
                            }
                        }
                    }

                    if (msg.type === "viewer-left") {
                        const peerId: string = msg.peerId;
                        const pc = peerConnectionsRef.current.get(peerId);
                        if (pc) {
                            pc.close();
                            peerConnectionsRef.current.delete(peerId);
                            console.log(`[WebRTC Provider] Viewer ${peerId} left, PC closed`);
                        }
                    }
                };

                signalWs.onclose = () => {
                    if (isActive) {
                        setIsStreaming(false);
                        reconnectTimeout = setTimeout(initProvider, 3000);
                    }
                };
                signalWs.onerror = (e) => console.error("[Signal WS] error", e);

                // 3. Connect AI frame WS — send low-res frames for YOLO inference
                aiWs = new WebSocket(`${wsUrl}/ws/stream_in/${stream.id}`);
                aiWs.onopen = () => {
                    const canvas = document.createElement("canvas");
                    const ctx = canvas.getContext("2d", { willReadFrequently: false });
                    let sending = false; // gate to avoid overlapping sends

                    // Send frames at ~8 FPS, 384px wide, low quality for AI only
                    captureInterval = setInterval(() => {
                        if (!isActive || aiWs?.readyState !== WebSocket.OPEN || !localVideoRef.current) return;
                        if (localVideoRef.current.readyState < 2 || sending) return;

                        const vw = localVideoRef.current.videoWidth;
                        const vh = localVideoRef.current.videoHeight;
                        const targetW = 384;
                        const scale = targetW / vw;
                        canvas.width = targetW;
                        canvas.height = Math.round(vh * scale);

                        ctx?.drawImage(localVideoRef.current, 0, 0, canvas.width, canvas.height);

                        // Async blob encode — doesn't block the main thread
                        sending = true;
                        canvas.toBlob(
                            (blob) => {
                                sending = false;
                                if (!blob || aiWs?.readyState !== WebSocket.OPEN) return;
                                const reader = new FileReader();
                                reader.onloadend = () => {
                                    if (typeof reader.result === "string") {
                                        aiWs?.send(JSON.stringify({ type: "frame", frame: reader.result }));
                                    }
                                };
                                reader.readAsDataURL(blob);
                            },
                            "image/jpeg",
                            0.55,
                        );
                    }, 125); // ~8 FPS
                };
                aiWs.onclose = () => { /* handled by signalWs reconnect */ };

                // 4. Also subscribe to detection results for own overlay
                detWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
                detWs.onopen = () => {
                    detPingInterval = setInterval(() => {
                        if (detWs?.readyState === WebSocket.OPEN) {
                            detWs.send(JSON.stringify({ type: "ping", ts: Date.now() }));
                        }
                    }, 15000);
                };
                detWs.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === "detections" && data.detections) {
                            requestAnimationFrame(() => drawDetections(data.detections));
                            onDetections(data.detections, data.timestamp);
                        }
                    } catch { /* ignore */ }
                };

            } catch (err) {
                console.error("[StreamNode Provider] init error:", err);
                if (isActive) reconnectTimeout = setTimeout(initProvider, 3000);
            }
        };

        /* ============================================================== */
        /*  VIEWER PATH (client_cam, but NOT the camera owner)             */
        /* ============================================================== */
        const initViewerWebRTC = async () => {
            if (!isActive) return;
            setWsState("checking");

            try {
                const myPeerId = Math.random().toString(36).substring(2, 12);

                // 1. Signaling WS
                signalWs = new WebSocket(`${wsUrl}/ws/signal/${stream.id}`);

                signalWs.onopen = () => {
                    setWsState("connected");
                    signalWs!.send(JSON.stringify({ type: "viewer-join", peerId: myPeerId }));
                };

                signalWs.onmessage = async (event) => {
                    const msg = JSON.parse(event.data);

                    if (msg.type === "offer") {
                        console.log(`[WebRTC Viewer] Received offer, creating answer`);

                        // Close any stale previous PC before creating a new one
                        const oldPc = peerConnectionsRef.current.get("provider");
                        if (oldPc) { oldPc.close(); peerConnectionsRef.current.delete("provider"); }

                        const pc = new RTCPeerConnection(ICE_SERVERS);
                        peerConnectionsRef.current.set("provider", pc);

                        // Accumulate tracks into a single MediaStream so both
                        // video and audio end up on the <video> element — Safari
                        // sometimes fires ontrack with an empty e.streams[].
                        const combinedStream = new MediaStream();

                        pc.ontrack = (e) => {
                            console.log("[WebRTC Viewer] Got remote track", e.track.kind);
                            combinedStream.addTrack(e.track);

                            if (remoteVideoRef.current) {
                                remoteVideoRef.current.srcObject = combinedStream;
                                // Muted for autoplay (mobile requires this)
                                remoteVideoRef.current.muted = true;
                                safePlay(remoteVideoRef.current);
                                setVideoLoaded(true);
                                setIsStreaming(true);
                                streamingRef.current = true;
                            }
                        };

                        // Send null candidate too (end-of-candidates — Safari compat)
                        pc.onicecandidate = (e) => {
                            if (signalWs?.readyState !== WebSocket.OPEN) return;
                            if (e.candidate) {
                                signalWs.send(JSON.stringify({
                                    type: "ice-candidate",
                                    peerId: myPeerId,
                                    candidate: e.candidate.toJSON(),
                                }));
                            } else {
                                signalWs.send(JSON.stringify({
                                    type: "ice-candidate",
                                    peerId: myPeerId,
                                    candidate: null,
                                }));
                            }
                        };

                        pc.oniceconnectionstatechange = () => {
                            console.log(`[WebRTC Viewer] ICE state: ${pc.iceConnectionState}`);
                            if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
                                setIsStreaming(false);
                                setVideoLoaded(false);
                            }
                            if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
                                setIsStreaming(true);
                            }
                        };

                        // Apply H.264 preference to the incoming offer for Safari
                        const offerSdp = preferH264(msg.sdp || "");
                        await pc.setRemoteDescription(
                            new RTCSessionDescription({ type: "offer", sdp: offerSdp })
                        );
                        const answer = await pc.createAnswer();
                        answer.sdp = preferH264(answer.sdp || "");
                        await pc.setLocalDescription(answer);

                        signalWs!.send(JSON.stringify({
                            type: "answer",
                            peerId: myPeerId,
                            sdp: pc.localDescription?.sdp,
                        }));
                    }

                    if (msg.type === "ice-candidate") {
                        const pc = peerConnectionsRef.current.get("provider");
                        if (pc) {
                            if (msg.candidate) {
                                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
                            } else {
                                // null = end-of-candidates
                                await pc.addIceCandidate(undefined as any).catch(() => {});
                            }
                        }
                    }
                };

                signalWs.onclose = () => {
                    setIsStreaming(false);
                    setVideoLoaded(false);
                    if (isActive) reconnectTimeout = setTimeout(initViewerWebRTC, 3000);
                };
                signalWs.onerror = (e) => console.error("[Signal WS viewer] error", e);

                // 2. Detection overlay WS
                detWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
                detWs.onopen = () => {
                    detPingInterval = setInterval(() => {
                        if (detWs?.readyState === WebSocket.OPEN) {
                            detWs.send(JSON.stringify({ type: "ping", ts: Date.now() }));
                        }
                    }, 15000);
                };
                detWs.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === "detections" && data.detections) {
                            requestAnimationFrame(() => drawDetections(data.detections));
                            onDetections(data.detections, data.timestamp);
                        }
                    } catch { /* ignore */ }
                };

            } catch (err) {
                console.error("[StreamNode Viewer WebRTC] init error:", err);
                if (isActive) reconnectTimeout = setTimeout(initViewerWebRTC, 3000);
            }
        };

        /* ============================================================== */
        /*  FALLBACK VIEWER PATH (server_cam / rtsp — old WS frame mode)   */
        /* ============================================================== */
        const initFallbackViewer = async () => {
            if (!isActive) return;
            setWsState("checking");

            try {
                detWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
                detWs.onopen = () => {
                    setWsState("connected");
                    setIsStreaming(true);
                    streamingRef.current = true;
                    detPingInterval = setInterval(() => {
                        if (detWs?.readyState === WebSocket.OPEN) {
                            detWs.send(JSON.stringify({ type: "ping", ts: Date.now() }));
                        }
                    }, 15000);
                };
                detWs.onmessage = (event) => {
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
                detWs.onclose = () => {
                    setIsStreaming(false);
                    setVideoLoaded(false);
                    if (isActive) reconnectTimeout = setTimeout(initFallbackViewer, 3000);
                };
                detWs.onerror = (e) => console.error("[Fallback WS] error", e);
            } catch (err) {
                console.error("[StreamNode Fallback] init error:", err);
                if (isActive) reconnectTimeout = setTimeout(initFallbackViewer, 3000);
            }
        };

        /* ============================================================== */
        /*  Choose the right init path                                     */
        /* ============================================================== */
        const startDelay = setTimeout(() => {
            if (isClientCam) {
                if (isOwnerOfClientCam) {
                    initProvider();
                } else {
                    initViewerWebRTC();
                }
            } else {
                // server_cam or rtsp — use legacy WS frame broadcast
                initFallbackViewer();
            }
        }, 500);

        /* ============================================================== */
        /*  Cleanup on unmount / stream change                             */
        /* ============================================================== */
        return () => {
            isActive = false;
            streamingRef.current = false;
            setVideoLoaded(false);
            clearTimeout(startDelay);
            clearTimeout(reconnectTimeout);
            clearInterval(captureInterval);
            if (detPingInterval) clearInterval(detPingInterval);
            stopLocalStream();
            if (signalWs) signalWs.close();
            if (aiWs) aiWs.close();
            if (detWs) detWs.close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stream.id, isOwnerOfClientCam, isClientCam, hasMounted]);

    /* ------------------------------------------------------------------ */
    /*  Delete handler                                                     */
    /* ------------------------------------------------------------------ */
    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const confirmed = window.confirm(`Terminate ${stream.name}? This removes it for all users.`);
        if (confirmed) {
            onDelete(stream.id, true);
        }
    };

    /* ------------------------------------------------------------------ */
    /*  Determine which video element to show                              */
    /* ------------------------------------------------------------------ */
    const showLocalVideo = isOwnerOfClientCam;
    const showRemoteVideo = isClientCam && !isOwnerOfClientCam;
    const showFallbackImg = !isClientCam;

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.8 }}
            onClick={onSelect}
            className={`relative bg-[#0A0A0A] flex flex-col group cursor-pointer origin-center ${isPrimary ? "sm:col-span-2 sm:row-span-2 border-[2px] border-[var(--color-iron)]" : "border-[2px] border-[var(--color-dim)] overflow-hidden hover:border-[var(--color-data)]"}`}
        >
            {isPrimary && <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:32px_32px] opacity-10 pointer-events-none z-0" />}

            {/* Corner markers */}
            <div className="absolute top-4 left-4 border-l-[2px] border-t-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute top-4 right-4 border-r-[2px] border-t-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute bottom-4 left-4 border-l-[2px] border-b-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute bottom-4 right-4 border-r-[2px] border-b-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />

            {/* Header bar */}
            <div className={`p-2 flex justify-between z-30 bg-gradient-to-b from-black/80 to-transparent ${!isPrimary && "bg-black border-b-[2px] border-[var(--color-iron)]"} absolute top-0 left-0 w-full`}>
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[150px]`}>
                    {stream.name} [{stream.type.toUpperCase()}]
                    {isClientCam && !showFallbackImg && (
                        <span className="ml-1 text-green-400">WebRTC</span>
                    )}
                </span>
                <div className="flex gap-2">
                    {/* Audio mute toggle — visible for client_cam streams */}
                    {isClientCam && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                const next = !isMuted;
                                setIsMuted(next);

                                if (isOwnerOfClientCam) {
                                    // Mute/unmute the outgoing mic track
                                    localStreamRef.current?.getAudioTracks().forEach((t) => {
                                        t.enabled = !next;
                                    });
                                } else if (remoteVideoRef.current) {
                                    // Mute/unmute incoming audio on the video element
                                    remoteVideoRef.current.muted = next;
                                }
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
                {/* Loading spinner — hide once video has data */}
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
                                        : wsState === "connected" && !videoLoaded ? (isClientCam ? "WEBRTC NEGOTIATING" : "DECODING STREAM")
                                            : "AWAITING FEED"}
                                </span>
                                <span>]</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Local video preview (camera owner)
                     — position:absolute + z-10 so it sits in a proper stacking layer
                     — transform:translateZ(0) forces its own GPU compositing layer on
                       mobile, preventing the canvas overlay from "replacing" it visually */}
                {showLocalVideo && (
                    <video
                        ref={localVideoRef}
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        style={{ transform: "translateZ(0)" }}
                        autoPlay
                        muted
                        playsInline
                        webkit-playsinline=""
                        onLoadedData={() => setVideoLoaded(true)}
                    />
                )}

                {/* Remote WebRTC video (viewer of client_cam) */}
                {showRemoteVideo && (
                    <video
                        ref={remoteVideoRef}
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        style={{ transform: "translateZ(0)" }}
                        autoPlay
                        muted={isMuted}
                        playsInline
                        webkit-playsinline=""
                        onLoadedMetadata={() => { setVideoLoaded(true); setShowPlayButton(false); }}
                        onLoadedData={() => { setVideoLoaded(true); setShowPlayButton(false); }}
                    />
                )}

                {/* Fallback image for server_cam / rtsp */}
                {showFallbackImg && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                        ref={imgRef}
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        alt="Stream"
                    />
                )}

                {/* Detection overlay canvas — z-20 to sit above the z-10 video */}
                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />

                {/* Manual play button for mobile autoplay restrictions */}
                {showPlayButton && (
                    <div
                        className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); handleManualPlay(); }}
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
