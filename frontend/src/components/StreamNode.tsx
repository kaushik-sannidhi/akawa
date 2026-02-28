"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Trash2, Volume2, VolumeX, Play } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";
import { getVideoSDKToken } from "@/lib/videosdk";
import {
    MeetingProvider,
    useMeeting,
    useParticipant,
    MeetingConsumer,
} from "@videosdk.live/react-sdk";

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
/*  OUTER WRAPPER — wraps in MeetingProvider                           */
/* ================================================================== */
export default function StreamNode(props: StreamNodeProps) {
    const { stream } = props;
    const [hasMounted, setHasMounted] = useState(false);
    const [localDeviceId, setLocalDeviceId] = useState("pending");
    const [videosdkToken, setVideosdkToken] = useState<string | null>(null);

    useEffect(() => {
        let id = localStorage.getItem("device_id");
        if (!id) {
            id = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", id);
        }
        setLocalDeviceId(id);
        setHasMounted(true);

        // Fetch VideoSDK JWT token from backend
        getVideoSDKToken()
            .then((t) => setVideosdkToken(t))
            .catch((err) => console.error("Failed to get VideoSDK token:", err));
    }, []);;

    const isOwner = stream.type === "client_cam" && stream.device_id === localDeviceId;
    const isClientCam = stream.type === "client_cam";

    // Only render after mount (need localStorage for device_id) and token
    if (!hasMounted || !stream.room_id || !videosdkToken) {
        return <FallbackStreamNode {...props} />;
    }

    // For non-client_cam streams (server_cam / rtsp) use fallback WS viewer
    if (!isClientCam) {
        return <FallbackStreamNode {...props} />;
    }

    // Unique participantId per device session
    const participantId = `${localDeviceId}_${stream.id.substring(0, 6)}`;

    return (
        <MeetingProvider
            config={{
                meetingId: stream.room_id,
                micEnabled: isOwner,
                webcamEnabled: isOwner,
                name: isOwner ? "Camera" : "Viewer",
                participantId: participantId,
                debugMode: false,
            }}
            token={videosdkToken}
        >
            <StreamNodeInner
                {...props}
                isOwner={isOwner}
                localDeviceId={localDeviceId}
            />
        </MeetingProvider>
    );
}

/* ================================================================== */
/*  INNER — rendered inside MeetingProvider context                     */
/* ================================================================== */
interface InnerProps extends StreamNodeProps {
    isOwner: boolean;
    localDeviceId: string;
}

function StreamNodeInner({ stream, onDelete, onDetections, onSelect, isPrimary = false, isOwner, localDeviceId }: InnerProps) {
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isMuted, setIsMuted] = useState(true);
    const [showPlayButton, setShowPlayButton] = useState(false);
    const [wsState, setWsState] = useState<string>("init");

    const { join, leave, participants, localParticipant } = useMeeting({
        onMeetingJoined: () => {
            setWsState("connected");
            setIsStreaming(true);
            console.log("[VideoSDK] Meeting joined");
        },
        onMeetingLeft: () => {
            setIsStreaming(false);
            setVideoLoaded(false);
            console.log("[VideoSDK] Meeting left");
        },
        onParticipantJoined: (participant: any) => {
            console.log("[VideoSDK] Participant joined:", participant.id);
        },
        onParticipantLeft: (participant: any) => {
            console.log("[VideoSDK] Participant left:", participant.id);
        },
    });

    // Auto-join the meeting on mount
    useEffect(() => {
        setWsState("checking");
        // Small delay to ensure MeetingProvider is ready
        const timer = setTimeout(() => {
            join();
        }, 500);
        return () => {
            clearTimeout(timer);
            try { leave(); } catch { /* ignore */ }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stream.room_id]);

    // Find the camera provider's participant ID (the non-viewer one, or local if owner)
    const cameraParticipantId = useMemo(() => {
        if (isOwner && localParticipant) {
            return localParticipant.id;
        }
        // Viewer: find the first non-local participant with webcam
        for (const [pid, p] of participants) {
            if (pid !== localParticipant?.id) {
                return pid;
            }
        }
        return null;
    }, [isOwner, localParticipant, participants]);

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
    /*  Detection WebSocket (receive AI detection results from backend)     */
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
    /*  Delete handler                                                     */
    /* ------------------------------------------------------------------ */
    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const confirmed = window.confirm(`Terminate ${stream.name}? This removes it for all users.`);
        if (confirmed) {
            try { leave(); } catch { /* ignore */ }
            onDelete(stream.id, true);
        }
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

            {/* Corner markers */}
            <div className="absolute top-4 left-4 border-l-[2px] border-t-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute top-4 right-4 border-r-[2px] border-t-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute bottom-4 left-4 border-l-[2px] border-b-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute bottom-4 right-4 border-r-[2px] border-b-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />

            {/* Header bar */}
            <div className={`p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent ${!isPrimary && "bg-black border-b-[2px] border-[var(--color-iron)]"} absolute top-0 left-0 w-full`}>
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[150px]`}>
                    {stream.name} [{stream.type.toUpperCase()}]
                    <span className="ml-1 text-green-400">VideoSDK</span>
                </span>
                <div className="flex gap-2">
                    {/* Audio mute toggle */}
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
                                        : wsState === "connected" && !videoLoaded ? "VIDEOSDK NEGOTIATING"
                                            : "AWAITING FEED"}
                                </span>
                                <span>]</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Render camera participant's video */}
                {cameraParticipantId && (
                    <ParticipantVideo
                        participantId={cameraParticipantId}
                        isOwner={isOwner}
                        isMuted={isMuted}
                        streamId={stream.id}
                        onVideoLoaded={() => { setVideoLoaded(true); setShowPlayButton(false); }}
                    />
                )}

                {/* Detection overlay canvas — z-20 to sit above the z-10 video */}
                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />

                {/* Manual play button for mobile autoplay restrictions */}
                {showPlayButton && (
                    <div
                        className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); setShowPlayButton(false); }}
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

/* ================================================================== */
/*  PARTICIPANT VIDEO — renders one participant's video + audio         */
/* ================================================================== */
interface ParticipantVideoProps {
    participantId: string;
    isOwner: boolean;
    isMuted: boolean;
    streamId: string;
    onVideoLoaded: () => void;
}

function ParticipantVideo({ participantId, isOwner, isMuted, streamId, onVideoLoaded }: ParticipantVideoProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const micRef = useRef<HTMLAudioElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const {
        webcamStream,
        micStream,
        webcamOn,
        micOn,
        isLocal,
    } = useParticipant(participantId);

    // Attach webcam stream to video element
    useEffect(() => {
        if (!videoRef.current) return;
        if (webcamOn && webcamStream) {
            const mediaStream = new MediaStream();
            mediaStream.addTrack(webcamStream.track);
            videoRef.current.srcObject = mediaStream;
            videoRef.current.muted = true; // Always mute video element (audio via separate <audio>)
            videoRef.current.play().catch(() => { });
            onVideoLoaded();
        } else {
            videoRef.current.srcObject = null;
        }
    }, [webcamStream, webcamOn, onVideoLoaded]);

    // Attach mic stream to audio element
    useEffect(() => {
        if (!micRef.current) return;
        if (micOn && micStream && !isLocal) {
            const mediaStream = new MediaStream();
            mediaStream.addTrack(micStream.track);
            micRef.current.srcObject = mediaStream;
            micRef.current.play().catch((error) =>
                console.error("Audio play failed:", error)
            );
        } else {
            micRef.current.srcObject = null;
        }
    }, [micStream, micOn, isLocal]);

    // Control audio mute/unmute
    useEffect(() => {
        if (micRef.current) {
            micRef.current.muted = isMuted;
        }
    }, [isMuted]);

    // AI frame capture — only camera owner sends frames to backend for YOLO inference
    useEffect(() => {
        if (!isOwner || !webcamOn || !webcamStream) return;

        const wsUrl = getWsUrl();
        let aiWs: WebSocket | null = null;
        let captureInterval: ReturnType<typeof setInterval> | null = null;
        let active = true;

        const connectAiWs = () => {
            if (!active) return;
            aiWs = new WebSocket(`${wsUrl}/ws/stream_in/${streamId}`);

            aiWs.onopen = () => {
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d", { willReadFrequently: false });
                let sending = false;

                captureInterval = setInterval(() => {
                    if (!active || aiWs?.readyState !== WebSocket.OPEN || !videoRef.current) return;
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

            aiWs.onclose = () => {
                if (captureInterval) clearInterval(captureInterval);
                captureInterval = null;
                if (active) setTimeout(connectAiWs, 3000);
            };
        };

        connectAiWs();

        return () => {
            active = false;
            if (captureInterval) clearInterval(captureInterval);
            if (aiWs) aiWs.close();
        };
    }, [isOwner, webcamOn, webcamStream, streamId]);

    return (
        <>
            <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-cover z-10"
                style={{ transform: "translateZ(0)" }}
                autoPlay
                muted
                playsInline
                // @ts-ignore
                webkit-playsinline=""
            />
            {/* Hidden audio element for remote participant's mic */}
            {!isLocal && (
                <audio
                    ref={micRef}
                    autoPlay
                    playsInline
                    muted={isMuted}
                />
            )}
        </>
    );
}

/* ================================================================== */
/*  FALLBACK STREAM NODE — for server_cam / rtsp / no room_id          */
/* ================================================================== */
function FallbackStreamNode({ stream, onDelete, onDetections, onSelect, isPrimary = false }: StreamNodeProps) {
    const imgRef = useRef<HTMLImageElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [wsState, setWsState] = useState<string>("init");

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

    // Fallback WS viewer for server_cam / rtsp
    useEffect(() => {
        let active = true;
        const wsUrl = getWsUrl();
        let detWs: WebSocket | null = null;
        let pingInterval: ReturnType<typeof setInterval> | null = null;

        const connect = () => {
            if (!active) return;
            setWsState("checking");
            detWs = new WebSocket(`${wsUrl}/ws/stream_out/${stream.id}`);
            detWs.onopen = () => {
                setWsState("connected");
                setIsStreaming(true);
                pingInterval = setInterval(() => {
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
                if (active) setTimeout(connect, 3000);
            };
        };
        connect();

        return () => {
            active = false;
            if (pingInterval) clearInterval(pingInterval);
            if (detWs) detWs.close();
        };
    }, [stream.id, drawDetections, onDetections, videoLoaded]);

    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const confirmed = window.confirm(`Terminate ${stream.name}? This removes it for all users.`);
        if (confirmed) {
            onDelete(stream.id, true);
        }
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

            <div className="absolute top-4 left-4 border-l-[2px] border-t-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute top-4 right-4 border-r-[2px] border-t-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute bottom-4 left-4 border-l-[2px] border-b-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />
            <div className="absolute bottom-4 right-4 border-r-[2px] border-b-[2px] border-[var(--color-silica)] w-8 h-8 z-30 pointer-events-none opacity-50" />

            <div className={`p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent ${!isPrimary && "bg-black border-b-[2px] border-[var(--color-iron)]"} absolute top-0 left-0 w-full`}>
                <span className={`bg-black text-[var(--color-data)] px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] truncate max-w-[150px]`}>
                    {stream.name} [{stream.type.toUpperCase()}]
                </span>
                <div className="flex gap-2">
                    <span className={`bg-black px-2 font-bold ${isPrimary ? "text-[10px]" : "text-[8px]"} border-[1px] border-[var(--color-iron)] ${isStreaming ? 'text-[var(--color-alert)] animate-pulse' : 'text-[#333]'}`}>
                        {isStreaming ? 'REC' : 'WAITING'}
                    </span>
                    <button onClick={handleDelete} className="bg-black text-[var(--color-iron)] hover:text-red-500 hover:border-red-500 border border-[var(--color-iron)] px-1">
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

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
                                    {wsState === "checking" ? "CONNECTING"
                                        : wsState === "connected" && !videoLoaded ? "DECODING STREAM"
                                            : "AWAITING FEED"}
                                </span>
                                <span>]</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    ref={imgRef}
                    className="absolute inset-0 h-full w-full object-cover z-10"
                    alt="Stream"
                />

                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />
            </div>
        </motion.div>
    );
}
