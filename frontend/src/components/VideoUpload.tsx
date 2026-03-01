"use client";

import { useState } from "react";
import { HardDriveDownload } from "lucide-react";
import { useTelemetry } from "@/context/TelemetryContext";
import { auth } from "@/lib/firebase";
import { resolveBaseUrl } from "@/lib/config";

export default function VideoUpload({ onUploadComplete }: { onUploadComplete: (data: any) => void }) {
    const { logSysEvent } = useTelemetry();

    const [isUploading, setIsUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        const file = e.target.files[0];

        // Check size limit (e.g. 500MB)
        if (file.size > 500 * 1024 * 1024) {
            setError("[ ERROR ] TARGET FILE EXCEEDS 500MB BUFFER LIMIT.");
            return;
        }

        setIsUploading(true);
        setError(null);
        logSysEvent(`[INFO] COMMENCING FORENSIC FILE INGESTION [${file.name.toUpperCase()}]`);

        const formData = new FormData();
        formData.append("file", file);
        formData.append("uid", auth.currentUser?.uid || "anonymous");

        try {
            const baseUrl = await resolveBaseUrl(7000);
            const controller = new AbortController();
            // Large uploads + transcoding can exceed 2 minutes.
            const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000);
            const res = await fetch(`${baseUrl}/api/upload`, {
                method: "POST",
                body: formData,
                signal: controller.signal,
            });
            clearTimeout(timer);

            const data = await res.json().catch(() => ({}));
            if (!res.ok || data?.error || data?.detail) {
                const detail = data?.detail || data?.error || `INGESTION_FAILED (HTTP ${res.status})`;
                throw new Error(String(detail));
            }
            logSysEvent(`[INFO] INGESTION COMPLETE. BINDING ANALYSIS ENGINE TO [${file.name.toUpperCase()}]`);
            onUploadComplete(data);
        } catch (err: any) {
            const message = err?.name === "AbortError"
                ? "UPLOAD TIMED OUT DURING INGESTION/TRANSCODING."
                : (err?.message || "UNKNOWN INGESTION FAILURE");
            logSysEvent(`[ERROR] INGESTION FAILED - ${message}`);
            setError(`[ INGESTION ERROR ] ${message}`);
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div className="w-full max-w-xl mx-auto p-12 border-2 border-dashed border-[var(--color-iron)] bg-black flex flex-col items-center justify-center space-y-6 hover:border-[var(--color-data)] hover:bg-[var(--color-dim)] transition-none cursor-crosshair relative group font-mono uppercase tracking-widest text-[#FFF]">
            <input
                type="file"
                accept="video/mp4,video/x-m4v,video/*"
                onChange={handleFileChange}
                disabled={isUploading}
                className="absolute inset-0 w-full h-full opacity-0 cursor-crosshair z-20 title-none"
                title=""
            />

            <div className="p-4 border-[2px] border-[var(--color-iron)] bg-[var(--color-void)] group-hover:border-[var(--color-data)] group-hover:text-black group-hover:bg-[var(--color-data)] transition-none text-[var(--color-silica)]">
                <HardDriveDownload className="w-8 h-8" strokeWidth={1.5} />
            </div>

            <div className="text-center relative z-10 pointer-events-none">
                <h3 className="text-xl font-bold mb-2 break-all group-hover:text-white text-[var(--color-silica)]">
                    {isUploading ? "[ ALLOCATING_BUFFER... ]" : "[ INITIATE_FORENSIC_INGESTION ]"}
                </h3>
                <p className="text-[10px] text-[var(--color-iron)] group-hover:text-[var(--color-silica)]">
                    ACCEPTED FORMATS: MP4, AVI, MOV, WEBM.
                    <br />CAPACITY LIMIT: 500MB MAX.
                </p>
            </div>
            {error && <p className="text-[10px] text-black font-bold bg-[var(--color-alert)] px-2 py-1 uppercase absolute bottom-4 animate-pulse z-30">{error}</p>}
        </div>
    );
}
