"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Trash2, Wifi, WifiOff } from "lucide-react";
import { motion } from "framer-motion";
import { getWsUrl } from "@/lib/config";
import { requestRealtimeJoin, type RealtimeJoinRole } from "@/lib/cloudflare-calls";
import { useRealtimeKitClient } from "@cloudflare/realtimekit-react";
import {
    RtkControlbar,
    RtkParticipantsAudio,
    RtkSimpleGrid,
    RtkUiProvider,
} from "@cloudflare/realtimekit-react-ui";

interface StreamNodeProps {
    stream: any;
    onDelete: (id: string, cascadeDelete: boolean) => void;
    onDetections: (detections: any[], timestamp: number) => void;
    onSelect?: () => void;
    onDoubleClick?: () => void;
    isPrimary?: boolean;
}

const RTK_THEME_VARS: CSSProperties = {
    "--rtk-font-family": "var(--font-mono)",
    "--rtk-colors-brand-300": "255 255 255",
    "--rtk-colors-brand-500": "255 51 0",
    "--rtk-colors-background-1000": "0 0 0",
    "--rtk-colors-background-900": "10 10 10",
    "--rtk-colors-background-800": "18 18 18",
    "--rtk-colors-background-700": "24 24 24",
    "--rtk-colors-background-600": "51 51 51",
    "--rtk-colors-text-1000": "255 255 255",
    "--rtk-colors-text-700": "170 170 170",
    "--rtk-border-radius-none": "0px",
    "--rtk-border-radius-sm": "0px",
    "--rtk-border-radius-md": "0px",
    "--rtk-border-radius-lg": "0px",
} as CSSProperties;

function useClientCameraInferenceUploader(
    streamId: string,
    enabled: boolean,
    meeting: any,
    setIsStreaming: (value: boolean) => void,
) {
    const lastTrackIdRef = useRef<string>("");

    useEffect(() => {
        if (!enabled || !meeting) return;

        let alive = true;
        let ws: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let sendTimer: ReturnType<typeof setInterval> | null = null;

        const hiddenVideo = document.createElement("video");
        hiddenVideo.muted = true;
        hiddenVideo.playsInline = true;
        hiddenVideo.autoplay = true;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        const attachTrack = (track: MediaStreamTrack | null | undefined) => {
            if (!track) return;
            if (lastTrackIdRef.current === track.id) return;
            lastTrackIdRef.current = track.id;
            hiddenVideo.srcObject = new MediaStream([track]);
            hiddenVideo.play().catch(() => {});
        };

        const sendFrame = async () => {
            if (!ctx || !ws || ws.readyState !== WebSocket.OPEN) return;
            const track = meeting?.self?.videoTrack as MediaStreamTrack | undefined;
            if (!track) return;

            attachTrack(track);
            if (hiddenVideo.readyState < 2) return;

            const videoWidth = hiddenVideo.videoWidth;
            const videoHeight = hiddenVideo.videoHeight;
            if (!videoWidth || !videoHeight) return;

            const targetWidth = 480;
            const targetHeight = Math.max(1, Math.round((targetWidth / videoWidth) * videoHeight));
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            ctx.drawImage(hiddenVideo, 0, 0, targetWidth, targetHeight);

            const blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob((value) => resolve(value), "image/jpeg", 0.45);
            });

            if (blob && ws.readyState === WebSocket.OPEN) {
                ws.send(blob);
            }
        };

        const connect = () => {
            const wsUrl = getWsUrl();
            ws = new WebSocket(`${wsUrl}/ws/stream_in/${streamId}`);
            ws.binaryType = "arraybuffer";

            ws.onopen = () => {
                setIsStreaming(true);
                if (sendTimer) clearInterval(sendTimer);
                sendTimer = setInterval(() => {
                    void sendFrame();
                }, 120);
            };

            ws.onclose = () => {
                if (sendTimer) {
                    clearInterval(sendTimer);
                    sendTimer = null;
                }
                if (!alive) return;
                reconnectTimer = setTimeout(connect, 3000);
            };

            ws.onerror = () => {
                setIsStreaming(false);
            };
        };

        connect();

        return () => {
            alive = false;
            if (sendTimer) clearInterval(sendTimer);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            ws?.close();
            hiddenVideo.srcObject = null;
        };
    }, [enabled, meeting, setIsStreaming, streamId]);
}

function RealtimeClientView({
    stream,
    isOwner,
    localDeviceId,
    setVideoLoaded,
    setIsStreaming,
    setNetState,
}: {
    stream: any;
    isOwner: boolean;
    localDeviceId: string;
    setVideoLoaded: (value: boolean) => void;
    setIsStreaming: (value: boolean) => void;
    setNetState: (value: string) => void;
}) {
    const [meeting, initMeeting] = useRealtimeKitClient();

    useEffect(() => {
        if (!stream?.id || !stream?.cf_meeting_id || !localDeviceId) return;

        let alive = true;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let activeMeeting: any = null;

        const role: RealtimeJoinRole = isOwner ? "publisher" : "viewer";

        const join = async () => {
            setNetState("connecting_rtk");
            setIsStreaming(false);
            try {
                const joinData = await requestRealtimeJoin({
                    streamId: stream.id,
                    participantName: isOwner
                        ? `${stream.name || "Camera"} Publisher`
                        : `${stream.name || "Camera"} Viewer`,
                    deviceId: localDeviceId,
                    role,
                });

                const client = await initMeeting({
                    authToken: joinData.authToken,
                    defaults: {
                        audio: isOwner,
                        video: isOwner,
                    },
                });

                if (!alive || !client) return;

                activeMeeting = client;
                await client.join();

                if (!alive) return;

                if (isOwner) {
                    await client.self.enableVideo().catch(() => {});
                    await client.self.enableAudio().catch(() => {});
                } else {
                    await client.self.disableVideo().catch(() => {});
                    await client.self.disableAudio().catch(() => {});
                }

                setVideoLoaded(true);
                setIsStreaming(true);
                setNetState("streaming_rtk");
            } catch (error) {
                console.error("[RTK] Failed to join stream", stream.id, error);
                setNetState("rtk_error");
                setIsStreaming(false);
                if (alive) {
                    retryTimer = setTimeout(join, 5000);
                }
            }
        };

        void join();

        return () => {
            alive = false;
            if (retryTimer) clearTimeout(retryTimer);
            if (activeMeeting) {
                activeMeeting.leave().catch(() => {});
            }
        };
    }, [initMeeting, isOwner, localDeviceId, setIsStreaming, setNetState, setVideoLoaded, stream?.cf_meeting_id, stream?.id, stream?.name]);

    useClientCameraInferenceUploader(stream.id, Boolean(meeting && isOwner), meeting, setIsStreaming);

    if (!meeting) {
        return <div className="absolute inset-0 z-10 bg-[#0a0a0a]" />;
    }

    return (
        <div className="absolute inset-0 z-10 rtk-theme" style={RTK_THEME_VARS}>
            <RtkUiProvider meeting={meeting as any}>
                <div className="h-full w-full flex flex-col bg-black">
                    <div className="flex-1 min-h-0">
                        <RtkSimpleGrid />
                    </div>
                    <div className="border-t border-[var(--color-iron)] bg-black/85">
                        <RtkControlbar variant="boxed" />
                    </div>
                    <RtkParticipantsAudio />
                </div>
            </RtkUiProvider>
        </div>
    );
}

export default function StreamNode({
    stream,
    onDelete,
    onDetections,
    onSelect,
    onDoubleClick,
    isPrimary = false,
}: StreamNodeProps) {
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const lastDetRef = useRef<string>("");
    const lastDetectionsRaw = useRef<any[]>([]);
    const weaponSeenStartRef = useRef<number | null>(null);
    const pulsePhaseRef = useRef<number>(0);
    const rafRef = useRef<number>(0);

    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [netState, setNetState] = useState("init");
    const [fallbackFrame, setFallbackFrame] = useState("");
    const [localDeviceId, setLocalDeviceId] = useState("");

    const isClientCam = stream.type === "client_cam";
    const hasMeeting = Boolean(stream.cf_meeting_id);

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
                drawDetections(lastDetectionsRaw.current);
            }
            rafRef.current = requestAnimationFrame(animate);
        };

        rafRef.current = requestAnimationFrame(animate);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    const isOwner = useMemo(
        () => isClientCam && stream.device_id === localDeviceId,
        [isClientCam, localDeviceId, stream.device_id],
    );

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

        const phase = pulsePhaseRef.current;
        const pulseOpacity = 0.4 + 0.6 * (Math.sin(phase * Math.PI * 2) * 0.5 + 0.5);
        const hasWeapon = detections.some(
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

        detections.forEach((det: any) => {
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
    }, []);

    useEffect(() => {
        let alive = true;
        let ws: WebSocket | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const connect = () => {
            if (!alive) return;
            const wsUrl = getWsUrl();
            const wsPath = isClientCam ? `${wsUrl}/ws/detections/${stream.id}` : `${wsUrl}/ws/stream_out/${stream.id}`;

            ws = new WebSocket(wsPath);
            ws.onopen = () => {
                if (isClientCam) {
                    pingTimer = setInterval(() => {
                        if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
                    }, 25000);
                }
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);

                    if (data.type === "frame" && data.frame && !isClientCam) {
                        setFallbackFrame(`data:image/jpeg;base64,${data.frame}`);
                        setVideoLoaded(true);
                        setIsStreaming(true);
                    }

                    if (data.detections) {
                        const key = JSON.stringify(
                            data.detections.map((d: any) => `${d.class_name}:${Number(d.confidence || 0).toFixed(2)}`),
                        );
                        if (key !== lastDetRef.current) {
                            lastDetRef.current = key;
                            lastDetectionsRaw.current = data.detections;
                            drawDetections(data.detections);
                            onDetections(data.detections, Number(data.timestamp || Date.now()));
                        }
                    }
                } catch {
                    // Ignore malformed websocket payloads.
                }
            };

            ws.onclose = () => {
                if (pingTimer) {
                    clearInterval(pingTimer);
                    pingTimer = null;
                }
                if (alive) {
                    setTimeout(connect, 3000);
                }
            };
        };

        connect();

        return () => {
            alive = false;
            if (pingTimer) clearInterval(pingTimer);
            ws?.close();
        };
    }, [drawDetections, isClientCam, onDetections, stream.id]);

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
            className={`relative w-full h-full flex-1 min-h-0 bg-[#0A0A0A] flex flex-col group cursor-pointer origin-center border-[2px] overflow-hidden ${
                isPrimary
                    ? "border-[var(--color-data)]"
                    : "border-[var(--color-dim)] hover:border-[var(--color-iron)]"
            }`}
        >
            <div className="p-2 flex justify-between z-40 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 w-full">
                <span
                    className={`bg-black text-[var(--color-data)] px-2 font-bold ${
                        isPrimary ? "text-[10px]" : "text-[8px]"
                    } border-[1px] border-[var(--color-iron)] truncate max-w-[180px] whitespace-nowrap`}
                >
                    {stream.name} [{String(stream.type || "UNKNOWN").toUpperCase()}]
                </span>
                <div className="flex gap-1">
                    {isClientCam && (
                        <span
                            className={`bg-black px-1 border border-[var(--color-iron)] flex items-center ${
                                isStreaming ? "text-[var(--color-data)]" : "text-[#555]"
                            }`}
                        >
                            {isStreaming ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                        </span>
                    )}
                    <span
                        className={`bg-black px-2 font-bold ${
                            isPrimary ? "text-[10px]" : "text-[8px]"
                        } border-[1px] border-[var(--color-iron)] ${
                            isStreaming ? "text-[var(--color-alert)] animate-pulse" : "text-[#333]"
                        }`}
                    >
                        {isStreaming ? "LIVE" : "..."}
                    </span>
                    <button
                        onClick={handleDelete}
                        className="bg-black text-[var(--color-iron)] hover:text-red-500 hover:border-red-500 border border-[var(--color-iron)] px-1"
                    >
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
                        <div className="text-[10px] font-bold tracking-[0.2em] text-[var(--color-data)] whitespace-nowrap">
                            [{netState.replace(/_/g, " ").toUpperCase()}]
                        </div>
                    </div>
                )}

                {isClientCam && hasMeeting && localDeviceId && (
                    <RealtimeClientView
                        stream={stream}
                        isOwner={isOwner}
                        localDeviceId={localDeviceId}
                        setVideoLoaded={setVideoLoaded}
                        setIsStreaming={setIsStreaming}
                        setNetState={setNetState}
                    />
                )}

                {isClientCam && !hasMeeting && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center text-[10px] text-[var(--color-silica)] bg-black">
                        REALTIME_MEETING_NOT_CONFIGURED
                    </div>
                )}

                {!isClientCam && fallbackFrame && (
                    <img
                        src={fallbackFrame}
                        alt="Stream"
                        className="absolute inset-0 h-full w-full object-cover z-10"
                        onLoad={() => setVideoLoaded(true)}
                    />
                )}

                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full z-20 pointer-events-none" />
            </div>
        </motion.div>
    );
}
