"use client";

import { useState, useEffect } from "react";
import { useSettings } from "@/context/SettingsContext";
import { useTelemetry } from "@/context/TelemetryContext";
import { getBaseUrl } from "@/lib/config";

type ModelOption = { id: string; name: string };

export default function SettingsPage() {
    const { logSysEvent } = useTelemetry();
    const { confidenceThreshold, setConfidenceThreshold, selectedModel, setSelectedModel } = useSettings();
    const [models, setModels] = useState<ModelOption[]>([]);
    const [loading, setLoading] = useState(true);

    const displayConfidence = Math.round(confidenceThreshold * 100);

    // Fetch available models from backend
    useEffect(() => {
        const fetchModels = async () => {
            try {
                const res = await fetch(`${getBaseUrl()}/api/models`);
                const data = await res.json();
                setModels(data.models || []);
            } catch (err) {
                console.error("Failed to fetch models:", err);
                setModels([{ id: "latest", name: "Latest (Auto-Select)" }]);
            } finally {
                setLoading(false);
            }
        };
        fetchModels();
    }, []);

    const handleCommit = () => {
        logSysEvent(`[INFO] GLOBAL CONFIGURATION UPDATED [MODEL: ${selectedModel}, CONFIDENCE: ${displayConfidence}%]`);
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8 font-mono tracking-widest text-sm uppercase text-[var(--color-data)]">

            <div className="border-b-[2px] border-[var(--color-iron)] pb-4 mb-8">
                <h1 className="text-2xl font-black">[ SYSTEM_CONFIGURATION ]</h1>
                <p className="text-xs text-[var(--color-silica)] mt-2 border-l-[2px] border-[var(--color-data)] pl-2">ADJUST INFERENCE ENGINE, MODEL SELECTION, AND ALERT ROUTING PROTOCOLS.</p>
            </div>

            {/* Model Selection */}
            <section className="bg-black border-[2px] border-[var(--color-iron)] p-6 structure-block">
                <h2 className="text-[10px] font-bold text-[var(--color-silica)] border-b border-[var(--color-iron)] pb-2 mb-6">[ ACTIVE_MODEL ]</h2>

                <div className="space-y-4">
                    <div className="flex flex-col gap-2">
                        <span className="font-bold text-xs">SELECT DETECTION MODEL</span>
                        {loading ? (
                            <div className="text-[10px] text-[var(--color-silica)] animate-pulse">SCANNING MODELS...</div>
                        ) : (
                            <select
                                value={selectedModel}
                                onChange={(e) => setSelectedModel(e.target.value)}
                                className="bg-black border-[2px] border-[var(--color-iron)] text-[var(--color-data)] px-4 py-3 font-mono text-xs uppercase tracking-widest appearance-none cursor-crosshair hover:border-[var(--color-alert)] focus:border-[var(--color-alert)] focus:outline-none transition-none"
                            >
                                {models.map((m) => (
                                    <option key={m.id} value={m.id} className="bg-black text-[var(--color-data)]">
                                        {m.name}
                                    </option>
                                ))}
                            </select>
                        )}
                        <p className="text-[10px] text-[var(--color-silica)]">
                            TRAINED MODELS ARE DISCOVERED FROM RUNS/DETECT/. THIS APPLIES TO VIDEO ANALYSIS, LIVE FEED, AND CCTV.
                        </p>
                    </div>

                    {/* Show selected model info */}
                    <div className="flex items-start justify-between border-[2px] border-[var(--color-alert)] p-4 bg-[var(--color-alert)]/10 mt-4">
                        <div>
                            <h3 className="font-bold text-lg mb-1 text-[var(--color-alert)]">
                                {models.find((m) => m.id === selectedModel)?.name || selectedModel.toUpperCase()}
                            </h3>
                            <p className="text-xs text-[var(--color-silica)]">
                                {selectedModel === "latest"
                                    ? "AUTO-SELECTS THE MOST RECENTLY TRAINED MODEL FROM RUNS/DETECT/."
                                    : `USING SPECIFIC MODEL: ${selectedModel.toUpperCase()}`}
                            </p>
                        </div>
                        <div className="w-6 h-6 border-[2px] border-current text-[var(--color-alert)] flex items-center justify-center">
                            <div className="w-3 h-3 bg-current" />
                        </div>
                    </div>
                </div>
            </section>

            {/* Global Thresholds */}
            <section className="bg-black border-[2px] border-[var(--color-iron)] p-6">
                <h2 className="text-[10px] font-bold text-[var(--color-silica)] border-b border-[var(--color-iron)] pb-2 mb-6">[ GLOBAL_THRESHOLDS ]</h2>

                <div className="space-y-8">
                    <div>
                        <div className="flex justify-between mb-4">
                            <span className="font-bold">WEAPON CONFIDENCE THRESHOLD</span>
                            <span className="text-[var(--color-alert)] font-bold">{displayConfidence}%</span>
                        </div>
                        <input
                            type="range"
                            min="0.10" max="0.95" step="0.05"
                            value={confidenceThreshold}
                            onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
                            className="w-full appearance-none h-2 bg-[var(--color-dim)] border-[1px] border-[var(--color-iron)] outline-none cursor-crosshair accent-[var(--color-alert)]"
                        />
                        <p className="text-[10px] text-[var(--color-silica)] mt-2">
                            THIS THRESHOLD IS APPLIED GLOBALLY TO ALL VIDEO ANALYSIS AND LIVE CAMERA STREAMS.
                        </p>
                    </div>
                </div>
            </section>

            <div className="pt-4 flex justify-end gap-4">
                <button
                    onClick={handleCommit}
                    className="px-6 py-3 font-bold border-[2px] border-[var(--color-alert)] text-[var(--color-alert)] bg-black hover:bg-[var(--color-alert)] hover:text-black transition-none uppercase shadow-[8px_8px_0_var(--color-alert)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-[4px_4px_0_var(--color-alert)]"
                >
                    [ COMMIT_CONFIG ]
                </button>
            </div>
        </div>
    );
}
