"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getBaseUrl } from "@/lib/config";
import { auth } from "@/lib/firebase";

const WEAPON_CLASSES = ["gun", "knife", "violence"];

type FrameDetections = {
    timestamp: number;
    detections: any[];
};

export default function VideoPlayer({
    videoUrl,
    videoId,
    modelId = "latest",
    confidenceThreshold,
    onAlert,
    seekTrigger,
}: {
    videoUrl: string;
    videoId: string;
    modelId?: string;
    confidenceThreshold: number;
    onAlert: (detections: any, timestamp: number) => void;
    seekTrigger?: { time: number; id: number } | null;
}) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const onAlertRef = useRef(onAlert);
    onAlertRef.current = onAlert;
    const thresholdRef = useRef(confidenceThreshold);
    thresholdRef.current = confidenceThreshold;

    // Pre-analysis state
    const [analyzing, setAnalyzing] = useState(true);
    const [progress, setProgress] = useState(0);
    const [analysisStatus, setAnalysisStatus] = useState("INITIALIZING...");
    const detectionMapRef = useRef<FrameDetections[]>([]);
    const alertsFiredRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (seekTrigger && videoRef.current) {
            videoRef.current.currentTime = seekTrigger.time;
            videoRef.current.play();
        }
    }, [seekTrigger]);

    // === PRE-ANALYSIS: stream all detections from backend before playback ===
    useEffect(() => {
        const uid = auth.currentUser?.uid || "anonymous";
        const abortController = new AbortController();
        detectionMapRef.current = [];
        alertsFiredRef.current = new Set();
        setAnalyzing(true);
        setProgress(0);
        setAnalysisStatus("CONNECTING TO ANALYSIS ENGINE...");

        const runAnalysis = async () => {
            try {
                const res = await fetch(
                    `${getBaseUrl()}/api/analyze/${videoId}?uid=${encodeURIComponent(uid)}&model_id=${encodeURIComponent(modelId)}`,
                    { signal: abortController.signal }
                );

                const reader = res.body?.getReader();
                if (!reader) return;
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        try {
                            const payload = JSON.parse(line.slice(6));
                            if (!payload) continue;

                            if (payload.type === "start") {
                                setAnalysisStatus(`ANALYZING ${payload.total_samples} FRAMES...`);
                            } else if (payload.type === "frame") {
                                detectionMapRef.current.push({
                                    timestamp: payload.timestamp,
                                    detections: payload.detections,
                                });
                                setProgress(payload.progress);

                                // Fire alerts for weapons found during analysis
                                const weapons = payload.detections.filter(
                                    (d: any) => WEAPON_CLASSES.includes(d.class_name)
                                );
                                if (weapons.length > 0) {
                                    onAlertRef.current(weapons, payload.timestamp);

                                    // Trigger clip generation
                                    captureClipForAlert(payload.timestamp);
                                }

                                const pct = Math.round(payload.progress * 100);
                                setAnalysisStatus(`ANALYZING... ${pct}%`);
                            } else if (payload.type === "done") {
                                setAnalysisStatus(`ANALYSIS COMPLETE (${payload.total_analyzed} FRAMES)`);
                            }
                        } catch { }
                    }
                }
            } catch (e: any) {
                if (e.name !== "AbortError") {
                    console.error("Analysis stream error:", e);
                    setAnalysisStatus("ANALYSIS ERROR — RETRY UPLOAD");
                }
            } finally {
                setAnalyzing(false);
            }
        };

        runAnalysis();
        return () => abortController.abort();
    }, [videoId]);

    // Track recently captured clip timestamps to prevent overlapping captures
    const lastClipTimeRef = useRef<number>(-10); // initialized far past

    // Helper: Captures a short WebM clip of the video at a specific time
    const captureClipForAlert = async (timestamp: number) => {
        // Debounce to prevent multiple clips for the same event (e.g., if multiple frames trigger alerts in rapid succession)
        if (Math.abs(timestamp - lastClipTimeRef.current) < 5) return;
        lastClipTimeRef.current = timestamp;

        // Since we are running in the "pre-analysis" phase, the video might not be playing at `timestamp` right now.
        // We will create a hidden offscreen video element just for recording this clip
        try {
            const hiddenVideo = document.createElement("video");
            hiddenVideo.crossOrigin = "anonymous";
            hiddenVideo.src = `${getBaseUrl()}${videoUrl}`;
            hiddenVideo.muted = true;
            hiddenVideo.playsInline = true;

            // wait for metadata to know dimensions
            await new Promise((resolve) => {
                hiddenVideo.onloadedmetadata = resolve;
            });

            // we want to capture from timestamp - 2 to timestamp + 3
            const startTime = Math.max(0, timestamp - 2);
            hiddenVideo.currentTime = startTime;

            await new Promise((resolve, reject) => {
                hiddenVideo.oncanplay = resolve;
                hiddenVideo.onerror = reject;
            });

            const renderCanvas = document.createElement("canvas");
            renderCanvas.width = hiddenVideo.videoWidth;
            renderCanvas.height = hiddenVideo.videoHeight;
            const ctx = renderCanvas.getContext("2d");

            // captureStream 15fps
            const captureStream = renderCanvas.captureStream(15);
            const mediaRecorder = new MediaRecorder(captureStream, { mimeType: "video/webm" });
            const chunks: Blob[] = [];

            mediaRecorder.ondataavailable = (e) => chunks.push(e.data);

            const recordPromise = new Promise<Blob>((resolve) => {
                mediaRecorder.onstop = () => {
                    resolve(new Blob(chunks, { type: "video/webm" }));
                };
            });

            mediaRecorder.start();
            hiddenVideo.play();

            // Render loop for the clip
            const duration = 5000; // record for 5 seconds
            const recStart = Date.now();

            const drawLoop = () => {
                if (Date.now() - recStart > duration) {
                    hiddenVideo.pause();
                    mediaRecorder.stop();
                    return;
                }
                if (ctx && hiddenVideo.readyState >= 2) {
                    ctx.drawImage(hiddenVideo, 0, 0, renderCanvas.width, renderCanvas.height);
                }
                requestAnimationFrame(drawLoop);
            };
            drawLoop();

            const clipBlob = await recordPromise;

            // Dispatch a custom event with the generated clip
            const event = new CustomEvent('awca_clip_generated', {
                detail: {
                    videoId,
                    timestamp,
                    videoBlob: clipBlob
                }
            });
            window.dispatchEvent(event);

            // Cleanup hidden elements
            hiddenVideo.src = "";
            hiddenVideo.remove();
            renderCanvas.remove();
        } catch (err) {
            console.error("Failed to generate clip for alert:", err);
        }
    };

    // === PLAYBACK: render cached detections in sync with video ===
    useEffect(() => {
        let animFrame: number;

        const renderLoop = () => {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (!video || !canvas) {
                animFrame = requestAnimationFrame(renderLoop);
                return;
            }

            const ctx = canvas.getContext("2d");
            if (!ctx) {
                animFrame = requestAnimationFrame(renderLoop);
                return;
            }

            const { videoWidth, videoHeight } = video;
            if (videoWidth && videoHeight) {
                if (canvas.width !== videoWidth) canvas.width = videoWidth;
                if (canvas.height !== videoHeight) canvas.height = videoHeight;
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (!video.paused && !video.ended && detectionMapRef.current.length > 0) {
                const currentTime = video.currentTime;

                // Binary search for the closest analyzed frame
                const frames = detectionMapRef.current;
                let lo = 0, hi = frames.length - 1;
                while (lo < hi) {
                    const mid = Math.floor((lo + hi + 1) / 2);
                    if (frames[mid].timestamp <= currentTime) {
                        lo = mid;
                    } else {
                        hi = mid - 1;
                    }
                }
                const nearest = frames[lo];

                // Only render if the nearest frame is within 0.4s of current time
                if (nearest && Math.abs(nearest.timestamp - currentTime) < 0.4) {
                    nearest.detections.forEach((d: any) => {
                        if (d.confidence < thresholdRef.current) return;

                        const { x1: nx1, y1: ny1, x2: nx2, y2: ny2 } = d.bbox;

                        let color = "#888888";
                        let label = d.class_name;

                        if (WEAPON_CLASSES.includes(d.class_name)) {
                            color = "#FF2222";
                            label = "WEAPON";
                        } else if (d.class_name === "person") {
                            color = "#888888";
                            label = "PERSON";
                        } else if (["umbrella", "chip_bag"].includes(d.class_name)) {
                            color = "#FFCC00";
                            label = d.class_name.toUpperCase();
                        }

                        const px1 = nx1 * canvas.width;
                        const py1 = ny1 * canvas.height;
                        const sw = (nx2 - nx1) * canvas.width;
                        const sh = (ny2 - ny1) * canvas.height;

                        // Semi-transparent fill
                        ctx.fillStyle = color + "15";
                        ctx.fillRect(px1, py1, sw, sh);

                        // Bounding box
                        ctx.strokeStyle = color;
                        ctx.lineWidth = 3;
                        ctx.strokeRect(px1, py1, sw, sh);

                        // Label bg + text
                        ctx.fillStyle = color;
                        ctx.font = "bold 16px monospace";
                        const text = `${label} ${(d.confidence * 100).toFixed(0)}%`;
                        const tw = ctx.measureText(text).width;
                        ctx.fillRect(px1, py1 - 24, tw + 8, 24);

                        ctx.fillStyle = "white";
                        ctx.fillText(text, px1 + 4, py1 - 6);
                    });
                }
            }

            animFrame = requestAnimationFrame(renderLoop);
        };

        animFrame = requestAnimationFrame(renderLoop);
        return () => cancelAnimationFrame(animFrame);
    }, []);

    return (
        <div className="relative w-full aspect-video bg-black rounded overflow-hidden">
            {/* Analysis progress overlay */}
            {analyzing && (
                <div className="absolute inset-0 z-30 bg-black/90 flex flex-col items-center justify-center gap-4 font-mono uppercase tracking-widest text-xs">
                    <div className="w-2 h-2 bg-[var(--color-alert)] animate-pulse" />
                    <span className="text-[var(--color-data)] font-bold">{analysisStatus}</span>
                    <div className="w-64 h-2 bg-[var(--color-dim)] border border-[var(--color-iron)]">
                        <div
                            className="h-full bg-[var(--color-alert)] transition-all duration-200"
                            style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                    </div>
                    <span className="text-[10px] text-[var(--color-silica)]">
                        PRE-ANALYZING ALL FRAMES FOR INSTANT PLAYBACK OVERLAY
                    </span>
                </div>
            )}

            <video
                ref={videoRef}
                src={`${getBaseUrl()}${videoUrl}`}
                controls
                className="w-full h-full object-contain"
                crossOrigin="anonymous"
            />
            <canvas
                ref={canvasRef}
                className="absolute top-0 left-0 w-full h-full pointer-events-none object-contain"
            />
        </div>
    );
}
