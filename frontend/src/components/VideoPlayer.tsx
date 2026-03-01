"use client";

import { useEffect, useRef, useState } from "react";
import { getBaseUrl, resolveBaseUrl } from "@/lib/config";
import { auth } from "@/lib/firebase";

const WEAPON_CLASSES = ["gun", "knife", "violence"];
const WEAPON_ALERT_CONFIDENCE_THRESHOLD = 0.85; // Only alert on weapons above this confidence

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

    // Pre-analysis / Hybrid state
    const [analyzing, setAnalyzing] = useState(true);
    const [progress, setProgress] = useState(0);
    const [analysisStatus, setAnalysisStatus] = useState("INITIALIZING ENGINE...");
    const [videoLoading, setVideoLoading] = useState(true);
    const [videoError, setVideoError] = useState<string | null>(null);
    const detectionMapRef = useRef<FrameDetections[]>([]);
    const isAnalyzingRef = useRef(false);
    const alertsFiredRef = useRef<Set<string>>(new Set());
    const [baseUrl, setBaseUrl] = useState(getBaseUrl());

    // Temporal context for live loop
    const frameHistoryRef = useRef<string[]>([]);

    useEffect(() => {
        setBaseUrl(getBaseUrl());
    }, []);

    useEffect(() => {
        if (seekTrigger && videoRef.current) {
            videoRef.current.currentTime = seekTrigger.time;
            videoRef.current.play().catch(err => console.error("Playback failed:", err));
        }
    }, [seekTrigger]);

    // === BACKGROUND ANALYSIS (SSE) ===
    useEffect(() => {
        if (!videoId) return;

        // Reset state for new video
        detectionMapRef.current = [];
        alertsFiredRef.current.clear();
        setAnalyzing(true);
        setProgress(0);
        setAnalysisStatus("SYNCING FORENSIC CACHE...");

        let eventSource: EventSource | null = null;
        let bufferMet = false;

        const startBackgroundSync = () => {
            const url = `${baseUrl}/api/analyze/${videoId}?model_id=${modelId}`;
            eventSource = new EventSource(url);

            eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "frame") {
                        detectionMapRef.current.push({
                            timestamp: data.timestamp,
                            detections: data.detections || []
                        });
                        // Keep sorted
                        detectionMapRef.current.sort((a, b) => a.timestamp - b.timestamp);
                        setProgress(data.progress || 0);

                        // If we have ~8 seconds analyzed, we can start playing "safely"
                        if (!bufferMet && data.timestamp > 8) {
                            bufferMet = true;
                            setAnalyzing(false);
                        }

                        // Check for threats in background to fire alerts early
                        const threats = (data.detections || []).filter((d: any) => {
                            const isWeapon = WEAPON_CLASSES.includes(d.class_name) || d.detection_type === "weapon";
                            const isThreat = isWeapon || d.detection_type === "violent_person" || d.detection_type === "fall" || d.is_threat;
                            if (isWeapon) return d.confidence >= WEAPON_ALERT_CONFIDENCE_THRESHOLD;
                            return isThreat && d.confidence >= thresholdRef.current;
                        });

                        if (threats.length > 0) {
                            const alertKey = `${data.timestamp}_${threats[0].class_name}`;
                            if (!alertsFiredRef.current.has(alertKey)) {
                                alertsFiredRef.current.add(alertKey);
                                onAlertRef.current(threats, data.timestamp);
                            }
                        }
                    } else if (data.type === "done") {
                        setAnalyzing(false);
                        eventSource?.close();
                    }
                } catch (e) {
                    console.error("SSE Parse Error:", e);
                }
            };

            eventSource.onerror = (err) => {
                console.error("SSE Connection Error:", err);
                // Fallback: hide analyzer after 5s anyway if SSE fails
                setTimeout(() => setAnalyzing(false), 5000);
                eventSource?.close();
            };
        };

        const timer = setTimeout(startBackgroundSync, 500);

        return () => {
            clearTimeout(timer);
            eventSource?.close();
        };
    }, [videoId, baseUrl, modelId]);

    // === LIVE ANALYSIS LOOP (Smart Fallback) ===
    const analysisIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        const videoEl = videoRef.current;
        if (!videoEl) return;

        const startAnalysis = () => {
            if (analysisIntervalRef.current) return;

            analysisIntervalRef.current = setInterval(async () => {
                if (!videoEl || videoEl.paused || videoEl.ended || isAnalyzingRef.current) return;

                const currentTime = videoEl.currentTime;

                const isCached = detectionMapRef.current.some(
                    (d) => Math.abs(d.timestamp - currentTime) < 0.2
                );
                if (isCached) return;

                isAnalyzingRef.current = true;

                try {
                    const canvas = document.createElement("canvas");
                    const ctx = canvas.getContext("2d");
                    if (!ctx || videoEl.videoWidth === 0) throw new Error("Canvas context missing");

                    const targetWidth = 480;
                    const targetHeight = Math.round((targetWidth / videoEl.videoWidth) * videoEl.videoHeight);
                    canvas.width = targetWidth;
                    canvas.height = targetHeight;
                    ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);

                    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.65));
                    if (!blob) throw new Error("Blob creation failed");

                    const buffer = await blob.arrayBuffer();
                    const b64Str = btoa(new Uint8Array(buffer).reduce((acc, byte) => acc + String.fromCharCode(byte), ""));

                    frameHistoryRef.current.push(b64Str);
                    if (frameHistoryRef.current.length > 5) frameHistoryRef.current.shift();

                    const res = await fetch(`${baseUrl}/api/detect`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            frame_sequence_b64: frameHistoryRef.current,
                            video_name: `live_detect_${videoId}`,
                            source_type: "upload",
                            stream_id: `upload_${videoId}`,
                        })
                    });

                    if (!res.ok) throw new Error("Detection API failed");
                    const data = await res.json();
                    const detections = data.detections || [];

                    detectionMapRef.current.push({ timestamp: currentTime, detections });
                    detectionMapRef.current.sort((a, b) => a.timestamp - b.timestamp);

                    const threats = detections.filter((d: any) => {
                        const isWeapon = WEAPON_CLASSES.includes(d.class_name) || d.detection_type === "weapon";
                        if (isWeapon) return d.confidence >= WEAPON_ALERT_CONFIDENCE_THRESHOLD;
                        return (d.detection_type === "violent_person" || d.detection_type === "fall" || d.is_threat) && d.confidence >= thresholdRef.current;
                    });

                    if (threats.length > 0) {
                        onAlertRef.current(threats, currentTime);
                        captureClipForAlert(currentTime);
                    }
                } catch (err) {
                    console.error("Live analysis drop:", err);
                } finally {
                    isAnalyzingRef.current = false;
                }
            }, 150);
        };

        const stopAnalysis = () => {
            if (analysisIntervalRef.current) { clearInterval(analysisIntervalRef.current); analysisIntervalRef.current = null; }
        };

        videoEl.addEventListener("play", startAnalysis);
        videoEl.addEventListener("pause", stopAnalysis);
        videoEl.addEventListener("ended", stopAnalysis);
        return () => {
            stopAnalysis();
            videoEl.removeEventListener("play", startAnalysis);
            videoEl.removeEventListener("pause", stopAnalysis);
            videoEl.removeEventListener("ended", stopAnalysis);
        };
    }, [videoId, baseUrl]);

    // Track recently captured clip timestamps
    const lastClipTimeRef = useRef<number>(-10);

    const captureClipForAlert = async (timestamp: number) => {
        if (Math.abs(timestamp - lastClipTimeRef.current) < 5) return;
        lastClipTimeRef.current = timestamp;

        try {
            const hiddenVideo = document.createElement("video");
            hiddenVideo.crossOrigin = "anonymous";
            hiddenVideo.src = `${baseUrl}${videoUrl}`;
            hiddenVideo.muted = true;
            await new Promise((r) => hiddenVideo.onloadedmetadata = r);

            const startTime = Math.max(0, timestamp - 2);
            hiddenVideo.currentTime = startTime;
            await new Promise((r) => hiddenVideo.onseeked = r);

            const renderCanvas = document.createElement("canvas");
            renderCanvas.width = hiddenVideo.videoWidth;
            renderCanvas.height = hiddenVideo.videoHeight;
            const ctx = renderCanvas.getContext("2d");
            if (ctx) ctx.drawImage(hiddenVideo, 0, 0);
            const frameBlob = await new Promise<Blob | null>((r) => renderCanvas.toBlob(r, "image/jpeg", 0.85));

            const captureStream = (renderCanvas as any).captureStream(12);
            const mediaRecorder = new MediaRecorder(captureStream, { mimeType: "video/webm" });
            const chunks: Blob[] = [];
            mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
            const recordPromise = new Promise<Blob>((r) => mediaRecorder.onstop = () => r(new Blob(chunks, { type: "video/webm" })));

            mediaRecorder.start();
            hiddenVideo.play();
            setTimeout(() => { hiddenVideo.pause(); mediaRecorder.stop(); }, 5000);

            const drawLoop = () => {
                if (mediaRecorder.state === "recording") {
                    if (ctx) ctx.drawImage(hiddenVideo, 0, 0);
                    requestAnimationFrame(drawLoop);
                }
            };
            drawLoop();

            const clipBlob = await recordPromise;
            window.dispatchEvent(new CustomEvent('awca_clip_generated', {
                detail: { videoId, timestamp, videoBlob: clipBlob, frameBlob }
            }));
            hiddenVideo.remove(); renderCanvas.remove();
        } catch (err) { console.error("Clip generation failed:", err); }
    };

    // Render loop persists cached boxes
    useEffect(() => {
        let animFrame: number;
        const renderLoop = () => {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (video && canvas && !video.paused && !video.ended) {
                const ctx = canvas.getContext("2d");
                if (ctx) {
                    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
                    ctx.clearRect(0, 0, canvas.width, canvas.height);

                    const ct = video.currentTime;
                    const frames = detectionMapRef.current;
                    let lo = 0, hi = frames.length - 1;
                    while (lo < hi) {
                        const mid = Math.floor((lo + hi + 1) / 2);
                        if (frames[mid].timestamp <= ct) lo = mid; else hi = mid - 1;
                    }
                    const nearest = frames[lo];

                    if (nearest && Math.abs(nearest.timestamp - ct) < 0.5) {
                        nearest.detections.forEach((d: any) => {
                            if (d.confidence < (d.class_name === "person" ? 0.25 : thresholdRef.current)) return;
                            const isWeapon = WEAPON_CLASSES.includes(d.class_name) || ["weapon", "violent_person", "fall"].includes(d.detection_type);
                            const { x1, y1, x2, y2 } = d.bbox;
                            const px = x1 * canvas.width, py = y1 * canvas.height;
                            const pw = (x2 - x1) * canvas.width, ph = (y2 - y1) * canvas.height;

                            ctx.strokeStyle = isWeapon ? "rgba(255, 51, 0, 0.8)" : "rgba(0, 220, 255, 0.7)";
                            ctx.lineWidth = isWeapon ? 4 : 2;
                            ctx.strokeRect(px, py, pw, ph);
                            ctx.fillStyle = isWeapon ? "rgba(255, 51, 0, 0.2)" : "rgba(0, 220, 255, 0.05)";
                            ctx.fillRect(px, py, pw, ph);

                            const label = `${(d.class_name || "OBJ").toUpperCase()} ${(d.confidence * 100).toFixed(0)}%`;
                            ctx.font = "bold 12px Inter, sans-serif";
                            const tw = ctx.measureText(label).width;
                            ctx.fillStyle = isWeapon ? "#FF3300" : "rgba(0, 150, 180, 0.8)";
                            ctx.fillRect(px, py - 18, tw + 8, 18);
                            ctx.fillStyle = "white";
                            ctx.fillText(label, px + 4, py - 5);
                        });
                    }
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
                <div className="absolute inset-0 z-30 bg-black/95 flex flex-col items-center justify-center gap-4 font-mono uppercase tracking-widest text-xs">
                    <div className="w-2 h-2 bg-[var(--color-alert)] animate-pulse" />
                    <span className="text-[var(--color-data)] font-bold">{analysisStatus}</span>
                    <div className="w-64 h-2 bg-[var(--color-dim)] border border-[var(--color-iron)]">
                        <div
                            className="h-full bg-[var(--color-alert)] transition-all duration-300"
                            style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                    </div>
                    <span className="text-[10px] text-[var(--color-silica)]">
                        SYNCHRONIZING FORENSIC META-CACHE FOR INSTANT OVERLAY
                    </span>
                </div>
            )}

            {/* Video Loading / Error state */}
            {(videoLoading || videoError) && !analyzing && (
                <div className="absolute inset-0 z-20 bg-black/80 flex flex-col items-center justify-center gap-4 p-8 text-center text-[10px] font-bold">
                    {videoError ? (
                        <span className="text-[var(--color-alert)] uppercase">
                            [ FATAL_ERROR ]<br />{videoError}
                        </span>
                    ) : (
                        <span className="text-[var(--color-data)] uppercase">
                            [ BUFFERING_FORENSIC_STREAM... ]
                        </span>
                    )}
                </div>
            )}

            <video
                ref={videoRef}
                src={`${baseUrl}${videoUrl}`}
                controls
                className="w-full h-full object-contain"
                crossOrigin="anonymous"
                onLoadStart={() => setVideoLoading(true)}
                onCanPlay={() => setVideoLoading(false)}
                onError={() => {
                    setVideoLoading(false);
                    setVideoError("VIDEO BUFFER CORRUPTED OR UNSUPPORTED FORMAT.");
                }}
            />
            <canvas
                ref={canvasRef}
                className="absolute top-0 left-0 w-full h-full pointer-events-none object-contain"
            />
        </div>
    );
}
