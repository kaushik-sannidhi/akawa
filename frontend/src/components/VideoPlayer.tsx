"use client";

import { useEffect, useRef, useState } from "react";
import { getBaseUrl, resolveBaseUrl } from "@/lib/config";
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
    const [videoLoading, setVideoLoading] = useState(true);
    const [videoError, setVideoError] = useState<string | null>(null);
    const detectionMapRef = useRef<FrameDetections[]>([]);
    const alertsFiredRef = useRef<Set<string>>(new Set());
    const [baseUrl, setBaseUrl] = useState(getBaseUrl());

    useEffect(() => {
        setBaseUrl(getBaseUrl());
    }, []);

    useEffect(() => {
        if (seekTrigger && videoRef.current) {
            videoRef.current.currentTime = seekTrigger.time;
            videoRef.current.play().catch(err => console.error("Playback failed:", err));
        }
    }, [seekTrigger]);

    // === LIVE ANALYSIS LOOP ===
    const analysisIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        setAnalyzing(false);
        const videoEl = videoRef.current;
        if (!videoEl) return;

        const startAnalysis = () => {
            if (analysisIntervalRef.current) return;

            // Run at ~2 FPS
            analysisIntervalRef.current = setInterval(async () => {
                if (!videoEl || videoEl.paused || videoEl.ended) return;

                const currentTime = videoEl.currentTime;

                // Check if we already analyzed within 0.3s of this timestamp to avoid redundant work
                const alreadyAnalyzed = detectionMapRef.current.some(
                    (d) => Math.abs(d.timestamp - currentTime) < 0.3
                );
                if (alreadyAnalyzed) return;

                try {
                    const canvas = document.createElement("canvas");
                    const ctx = canvas.getContext("2d");
                    if (!ctx || videoEl.videoWidth === 0) return;

                    const videoWidth = videoEl.videoWidth;
                    const videoHeight = videoEl.videoHeight;
                    const targetWidth = 480;
                    const targetHeight = Math.max(1, Math.round((targetWidth / videoWidth) * videoHeight));

                    canvas.width = targetWidth;
                    canvas.height = targetHeight;
                    ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);

                    const blob = await new Promise<Blob | null>((resolve) => {
                        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.6);
                    });
                    if (!blob) return;

                    const buffer = await blob.arrayBuffer();
                    const b64Str = btoa(new Uint8Array(buffer).reduce((acc, byte) => acc + String.fromCharCode(byte), ""));

                    const payload = {
                        frame_b64: b64Str,
                        video_name: `upload_${videoId}`,
                        source_type: "upload",
                        stream_id: `upload_${videoId}`,
                    };

                    const resolvedBaseUrl = getBaseUrl();
                    const res = await fetch(`${resolvedBaseUrl}/api/detect`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });

                    if (!res.ok) return;

                    const data = await res.json();
                    const detections = data.detections || [];

                    // Save detections for playback rendering
                    detectionMapRef.current.push({
                        timestamp: currentTime,
                        detections: detections
                    });

                    // Keep sorted for binary search
                    detectionMapRef.current.sort((a, b) => a.timestamp - b.timestamp);

                    // Check for threats using the same threshold/logic as before
                    const threats = detections.filter(
                        (d: any) => d.is_threat || WEAPON_CLASSES.includes(d.class_name) || ["weapon", "fall", "violent_person"].includes(d.detection_type)
                    );

                    if (threats.length > 0) {
                        onAlertRef.current(threats, currentTime);
                        captureClipForAlert(currentTime);
                    }
                } catch (err) {
                    // Fail silently for isolated frame errors to keep playback smooth
                    console.error("Live analysis frame drop:", err);
                }
            }, 500);
        };

        const stopAnalysis = () => {
            if (analysisIntervalRef.current) {
                clearInterval(analysisIntervalRef.current);
                analysisIntervalRef.current = null;
            }
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
    }, [videoId]);

    // Track recently captured clip timestamps to prevent overlapping captures
    const lastClipTimeRef = useRef<number>(-10); // initialized far past

    // Helper: Captures a short WebM clip of the video at a specific time
    const captureClipForAlert = async (timestamp: number) => {
        // Debounce to prevent multiple clips for the same event (e.g., if multiple frames trigger alerts in rapid succession)
        if (Math.abs(timestamp - lastClipTimeRef.current) < 5) return;
        lastClipTimeRef.current = timestamp;

        try {
            const hiddenVideo = document.createElement("video");
            hiddenVideo.crossOrigin = "anonymous";
            hiddenVideo.preload = "auto";
            hiddenVideo.src = `${baseUrl}${videoUrl}`;
            hiddenVideo.muted = true;
            hiddenVideo.playsInline = true;

            // wait for metadata to know dimensions
            await new Promise((resolve) => {
                hiddenVideo.onloadedmetadata = resolve;
            });

            // we want to capture from timestamp - 2 to timestamp + 3
            const startTime = Math.max(0, timestamp - 2);
            await new Promise<void>((resolve, reject) => {
                if (Math.abs(hiddenVideo.currentTime - startTime) < 0.01 && hiddenVideo.readyState >= 2) {
                    resolve();
                    return;
                }
                const onSeeked = () => {
                    hiddenVideo.removeEventListener("seeked", onSeeked);
                    hiddenVideo.removeEventListener("error", onError);
                    clearTimeout(fallbackTimer);
                    resolve();
                };
                const onError = () => {
                    hiddenVideo.removeEventListener("seeked", onSeeked);
                    hiddenVideo.removeEventListener("error", onError);
                    clearTimeout(fallbackTimer);
                    reject(new Error("Failed seeking hidden video"));
                };
                const fallbackTimer = setTimeout(() => {
                    hiddenVideo.removeEventListener("seeked", onSeeked);
                    hiddenVideo.removeEventListener("error", onError);
                    resolve();
                }, 800);
                hiddenVideo.addEventListener("seeked", onSeeked);
                hiddenVideo.addEventListener("error", onError);
                hiddenVideo.currentTime = startTime;
            });

            // Give the decoder a brief moment to paint a real frame.
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            const renderCanvas = document.createElement("canvas");
            renderCanvas.width = hiddenVideo.videoWidth;
            renderCanvas.height = hiddenVideo.videoHeight;
            const ctx = renderCanvas.getContext("2d");
            if (ctx && hiddenVideo.readyState >= 2 && hiddenVideo.videoWidth > 0 && hiddenVideo.videoHeight > 0) {
                ctx.drawImage(hiddenVideo, 0, 0, renderCanvas.width, renderCanvas.height);
            }
            const frameBlob = await new Promise<Blob | null>((resolve) =>
                renderCanvas.toBlob((b) => resolve(b), "image/jpeg", 0.82)
            );

            // captureStream 15fps
            const captureStream = (renderCanvas as any).captureStream(15);
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
                    videoBlob: clipBlob,
                    frameBlob
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
                    const phase = (Date.now() % 1000) / 1000;
                    const pulseOpacity = 0.4 + 0.6 * Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;

                    nearest.detections.forEach((d: any) => {
                        const isWeaponType = WEAPON_CLASSES.includes(d.class_name) || ["weapon", "gun"].includes(d.detection_type);

                        // Look back 1s to verify persistence
                        let isPersistentWeapon = false;
                        if (isWeaponType) {
                            const oneSecAgo = nearest.timestamp - 1.0;
                            // Filter frames in the last 1 second
                            const recentFrames = frames.slice(Math.max(0, lo - 15), lo + 1).filter(f => f.timestamp >= oneSecAgo && f.timestamp <= nearest.timestamp);
                            // Check if weapon was detected in those frames (at least 50% to be robust)
                            const weaponFrames = recentFrames.filter(f => f.detections.some(det => WEAPON_CLASSES.includes(det.class_name) || ["weapon", "gun"].includes(det.detection_type)));
                            if (weaponFrames.length >= Math.max(1, Math.floor(recentFrames.length * 0.5)) && (nearest.timestamp - recentFrames[0].timestamp >= 0.8)) {
                                isPersistentWeapon = true;
                            }
                        }

                        const isWeapon = isWeaponType && isPersistentWeapon;
                        const isPerson = d.class_name === "person";

                        // Person: lower threshold for situational awareness
                        const threshold = isPerson ? 0.25 : thresholdRef.current;
                        if (d.confidence < threshold) return;

                        const { x1: nx1, y1: ny1, x2: nx2, y2: ny2 } = d.bbox;
                        const px1 = nx1 * canvas.width;
                        const py1 = ny1 * canvas.height;
                        const sw = (nx2 - nx1) * canvas.width;
                        const sh = (ny2 - ny1) * canvas.height;

                        if (isWeapon) {
                            // High-Alert Weapon UI
                            const opacity = pulseOpacity;
                            const baseColor = `rgba(255, 51, 0, ${opacity})`;
                            const fillColor = `rgba(255, 51, 0, ${opacity * 0.2})`;

                            // Glow effect
                            ctx.lineWidth = 1;
                            for (let i = 1; i <= 3; i++) {
                                const offset = i * 4;
                                ctx.strokeStyle = `rgba(255, 51, 0, ${opacity * (0.3 / i)})`;
                                ctx.strokeRect(px1 - offset, py1 - offset, sw + offset * 2, sh + offset * 2);
                            }

                            // Main Box
                            ctx.strokeStyle = baseColor;
                            ctx.lineWidth = 4;
                            ctx.strokeRect(px1, py1, sw, sh);
                            ctx.fillStyle = fillColor;
                            ctx.fillRect(px1, py1, sw, sh);

                            // Crosshair
                            ctx.strokeStyle = baseColor;
                            ctx.lineWidth = 1;
                            ctx.beginPath();
                            ctx.moveTo(px1 + sw / 2 - 10, py1 + sh / 2);
                            ctx.lineTo(px1 + sw / 2 + 10, py1 + sh / 2);
                            ctx.moveTo(px1 + sw / 2, py1 + sh / 2 - 10);
                            ctx.lineTo(px1 + sw / 2, py1 + sh / 2 + 10);
                            ctx.stroke();

                            // Label Chip
                            const labelText = `${(d.class_name || "WEAPON").toUpperCase()} ${(d.confidence * 100).toFixed(0)}%`;
                            ctx.font = "bold 14px Inter, sans-serif";
                            const tw = ctx.measureText(labelText).width;
                            const chipHeight = 22;
                            ctx.fillStyle = "#FF3300";
                            ctx.fillRect(px1, py1 - chipHeight, tw + 12, chipHeight);
                            ctx.fillStyle = "white";
                            ctx.fillText(labelText, px1 + 6, py1 - 6);
                        } else {
                            // Presence / Passive Indicator
                            let color = "rgba(200, 200, 200, 0.5)";
                            if (["umbrella", "chip_bag"].includes(d.class_name)) color = "rgba(255, 204, 0, 0.7)";

                            ctx.strokeStyle = color;
                            ctx.lineWidth = 1.5;
                            ctx.strokeRect(px1, py1, sw, sh);
                            ctx.fillStyle = color.replace("0.5", "0.05").replace("0.7", "0.07");
                            ctx.fillRect(px1, py1, sw, sh);
                        }
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
                <div className="absolute inset-0 z-30 bg-black/95 flex flex-col items-center justify-center gap-4 font-mono uppercase tracking-widest text-xs">
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

            {/* Video Loading / Error state */}
            {(videoLoading || videoError) && !analyzing && (
                <div className="absolute inset-0 z-20 bg-black/80 flex flex-col items-center justify-center gap-4 p-8 text-center">
                    {videoError ? (
                        <>
                            <div className="w-8 h-8 flex items-center justify-center border-2 border-[var(--color-alert)] text-[var(--color-alert)] font-bold animate-pulse">!</div>
                            <span className="text-[var(--color-alert)] text-[10px] font-bold uppercase tracking-tighter">
                                [ FATAL_PLAYBACK_ERROR ]
                                <br /> {videoError}
                            </span>
                        </>
                    ) : (
                        <>
                            <div className="w-6 h-6 border-2 border-[var(--color-data)] border-t-transparent animate-spin rounded-full" />
                            <span className="text-[var(--color-data)] text-[10px] uppercase font-bold">[ BUFFERING_FORENSIC_STREAM... ]</span>
                        </>
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
