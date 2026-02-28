"use client";

import { useState, useEffect } from "react";
import { useSettings, AlertTypeConfig } from "@/context/SettingsContext";
import { useTelemetry } from "@/context/TelemetryContext";
import { getBaseUrl } from "@/lib/config";
import { Plus, X, Mail, Send } from "lucide-react";

type ModelOption = { id: string; name: string };

const ALERT_TYPE_META: Record<string, { label: string; icon: string; color: string; description: string }> = {
    gun: { label: "GUN", icon: "🔫", color: "var(--color-alert)", description: "Rifle, handgun, or firearm detected" },
    knife: { label: "KNIFE", icon: "🔪", color: "#ff9900", description: "Knife or bladed weapon detected" },
    fall: { label: "FALL", icon: "⚠️", color: "#ff6600", description: "Person fall event detected" },
    fight: { label: "FIGHT", icon: "👊", color: "#cc33ff", description: "Violence or brawl detected" },
};

export default function SettingsPage() {
    const { logSysEvent } = useTelemetry();
    const {
        confidenceThreshold, setConfidenceThreshold,
        selectedModel, setSelectedModel,
        notificationSettings, setNotificationSettings,
        saveNotificationSettings, notificationsLoaded,
    } = useSettings();
    const [models, setModels] = useState<ModelOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [newContact, setNewContact] = useState<Record<string, string>>({ gun: "", knife: "", fall: "", fight: "" });

    const displayConfidence = Math.round(confidenceThreshold * 100);

    useEffect(() => {
        const fetchModels = async () => {
            try {
                const res = await fetch(`${getBaseUrl()}/api/models`);
                const data = await res.json();
                setModels(data.models || []);
            } catch (err) {
                console.error("Failed to fetch models:", err);
                setModels([{ id: "latest", name: "Latest (Auto-Select)" }]);
            }
        };
        fetchModels().finally(() => setLoading(false));
    }, []);

    const handleCommit = async () => {
        setSaving(true);
        setSaved(false);
        logSysEvent(`[INFO] GLOBAL CONFIGURATION UPDATED [MODEL: ${selectedModel}, CONFIDENCE: ${displayConfidence}%]`);
        await saveNotificationSettings();
        logSysEvent(`[INFO] ALERT CONFIGURATION SYNCED WITH BACKEND`);
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
    };

    const updateAlertType = (type: string, updates: Partial<AlertTypeConfig>) => {
        setNotificationSettings({
            ...notificationSettings,
            alert_types: {
                ...notificationSettings.alert_types,
                [type]: { ...notificationSettings.alert_types[type as keyof typeof notificationSettings.alert_types], ...updates },
            },
        });
    };

    const addContact = (type: string) => {
        const email = newContact[type]?.trim();
        if (!email || !email.includes("@")) return;
        const current = notificationSettings.alert_types[type as keyof typeof notificationSettings.alert_types];
        if (current.contacts.includes(email)) return;
        updateAlertType(type, { contacts: [...current.contacts, email] });
        setNewContact({ ...newContact, [type]: "" });
    };

    const removeContact = (type: string, email: string) => {
        const current = notificationSettings.alert_types[type as keyof typeof notificationSettings.alert_types];
        updateAlertType(type, { contacts: current.contacts.filter((c) => c !== email) });
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

            {/* Notification Channels */}
            <section className="bg-black border-[2px] border-[var(--color-iron)] p-6 structure-block">
                <h2 className="text-[10px] font-bold text-[var(--color-silica)] border-b border-[var(--color-iron)] pb-2 mb-6">[ NOTIFICATION_CHANNELS ]</h2>

                {!notificationsLoaded ? (
                    <div className="text-[10px] text-[var(--color-silica)] animate-pulse">LOADING NOTIFICATION CONFIG...</div>
                ) : (
                    <div className="space-y-6">
                        {/* Email Channel */}
                        <div className="border border-[var(--color-iron)] p-4">
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-3">
                                    <Mail className="w-4 h-4 text-[var(--color-data)]" />
                                    <span className="font-bold text-xs">EMAIL ALERTS</span>
                                </div>
                                <label className="flex items-center gap-2 cursor-crosshair">
                                    <span className="text-[10px] text-[var(--color-silica)]">
                                        {notificationSettings.email_enabled ? "ENABLED" : "DISABLED"}
                                    </span>
                                    <input
                                        type="checkbox"
                                        checked={notificationSettings.email_enabled}
                                        onChange={(e) => setNotificationSettings({ ...notificationSettings, email_enabled: e.target.checked })}
                                        className="w-4 h-4 appearance-none border-[1px] border-[var(--color-iron)] checked:bg-[var(--color-data)] checked:border-[var(--color-data)] cursor-crosshair focus:outline-none"
                                    />
                                </label>
                            </div>
                            <div className={notificationSettings.email_enabled ? "" : "opacity-40 pointer-events-none"}>
                                <input
                                    type="email"
                                    placeholder="YOUR PRIMARY EMAIL"
                                    value={notificationSettings.email}
                                    onChange={(e) => setNotificationSettings({ ...notificationSettings, email: e.target.value })}
                                    className="w-full bg-black border-[2px] border-[var(--color-iron)] text-[var(--color-data)] px-4 py-3 font-mono text-xs uppercase tracking-widest focus:border-[var(--color-data)] outline-none"
                                />
                                <p className="text-[10px] text-[var(--color-silica)] mt-2">
                                    EMAILS ARE SENT VIA CLOUDFLARE WORKERS. THIS IS YOUR PRIMARY ALERT DESTINATION.
                                </p>
                            </div>
                        </div>

                        {/* Telegram Channel */}
                        <div className="border border-[var(--color-iron)] p-4">
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-3">
                                    <Send className="w-4 h-4 text-[#229ED9]" />
                                    <span className="font-bold text-xs text-[#229ED9]">TELEGRAM ALERTS</span>
                                </div>
                                <label className="flex items-center gap-2 cursor-crosshair">
                                    <span className="text-[10px] text-[var(--color-silica)]">
                                        {notificationSettings.telegram_enabled ? "ENABLED" : "DISABLED"}
                                    </span>
                                    <input
                                        type="checkbox"
                                        checked={notificationSettings.telegram_enabled}
                                        onChange={(e) => setNotificationSettings({ ...notificationSettings, telegram_enabled: e.target.checked })}
                                        className="w-4 h-4 appearance-none border-[1px] border-[var(--color-iron)] checked:bg-[#229ED9] checked:border-[#229ED9] cursor-crosshair focus:outline-none"
                                    />
                                </label>
                            </div>
                            <div className={notificationSettings.telegram_enabled ? "" : "opacity-40 pointer-events-none"}>
                                <div className="flex items-center">
                                    <span className="bg-[var(--color-dim)] border-[2px] border-r-0 border-[var(--color-iron)] text-[var(--color-silica)] px-3 py-3 font-mono text-xs">TEL</span>
                                    <input
                                        type="text"
                                        placeholder="TELEGRAM CHAT ID OR PHONE"
                                        value={notificationSettings.telegram_id}
                                        onChange={(e) => setNotificationSettings({ ...notificationSettings, telegram_id: e.target.value })}
                                        className="w-full bg-black border-[2px] border-[var(--color-iron)] text-[#229ED9] px-4 py-3 font-mono text-xs uppercase tracking-widest focus:border-[#229ED9] outline-none"
                                    />
                                </div>
                                <p className="text-[10px] text-[var(--color-silica)] mt-2">
                                    START THE AKAWA BOT ON TELEGRAM AND ENTER YOUR CHAT ID. MESSAGES ARE SENT VIA BOT API.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </section>

            {/* Per-Alert-Type Configuration */}
            <section className="bg-black border-[2px] border-[var(--color-iron)] p-6 structure-block">
                <h2 className="text-[10px] font-bold text-[var(--color-silica)] border-b border-[var(--color-iron)] pb-2 mb-6">[ ALERT_TYPE_ROUTING ]</h2>
                <p className="text-[10px] text-[var(--color-silica)] mb-6">
                    CONFIGURE WHICH CHANNELS ARE ACTIVE FOR EACH TYPE OF DETECTION EVENT. ADD ADDITIONAL CONTACTS TO BE EMAILED FOR EACH ALERT TYPE.
                </p>

                <div className="space-y-6">
                    {(["gun", "knife", "fall", "fight"] as const).map((type) => {
                        const meta = ALERT_TYPE_META[type];
                        const config = notificationSettings.alert_types[type];

                        return (
                            <div key={type} className="border-[2px] border-[var(--color-iron)] overflow-hidden">
                                {/* Header */}
                                <div className="flex items-center justify-between px-4 py-3 bg-[var(--color-dim)] border-b border-[var(--color-iron)]">
                                    <div className="flex items-center gap-3">
                                        <span className="text-lg">{meta.icon}</span>
                                        <div>
                                            <span className="font-bold text-xs" style={{ color: meta.color }}>{meta.label} DETECTION</span>
                                            <p className="text-[9px] text-[var(--color-silica)] mt-0.5 normal-case">{meta.description}</p>
                                        </div>
                                    </div>
                                </div>

                                {/* Channel toggles */}
                                <div className="p-4 space-y-4">
                                    <div className="flex flex-wrap gap-4">
                                        <label className="flex items-center gap-2 cursor-crosshair">
                                            <input
                                                type="checkbox"
                                                checked={config.email}
                                                onChange={(e) => updateAlertType(type, { email: e.target.checked })}
                                                className="w-4 h-4 appearance-none border-[1px] border-[var(--color-iron)] checked:bg-[var(--color-data)] checked:border-[var(--color-data)] cursor-crosshair focus:outline-none"
                                            />
                                            <Mail className="w-3 h-3 text-[var(--color-data)]" />
                                            <span className="text-[10px] font-bold">EMAIL</span>
                                        </label>

                                        <label className="flex items-center gap-2 cursor-crosshair">
                                            <input
                                                type="checkbox"
                                                checked={config.telegram}
                                                onChange={(e) => updateAlertType(type, { telegram: e.target.checked })}
                                                className="w-4 h-4 appearance-none border-[1px] border-[var(--color-iron)] checked:bg-[#229ED9] checked:border-[#229ED9] cursor-crosshair focus:outline-none"
                                            />
                                            <Send className="w-3 h-3 text-[#229ED9]" />
                                            <span className="text-[10px] font-bold">TELEGRAM</span>
                                        </label>
                                    </div>

                                    {/* Additional Contacts */}
                                    {config.email && (
                                        <div className="border-t border-[var(--color-iron)] pt-3 mt-3">
                                            <span className="text-[10px] font-bold text-[var(--color-silica)] block mb-2">ADDITIONAL EMAIL CONTACTS</span>

                                            {config.contacts.length > 0 && (
                                                <div className="flex flex-wrap gap-2 mb-3">
                                                    {config.contacts.map((contact) => (
                                                        <div
                                                            key={contact}
                                                            className="flex items-center gap-1 bg-[var(--color-dim)] border border-[var(--color-iron)] px-2 py-1 text-[10px] text-[var(--color-data)]"
                                                        >
                                                            <span className="normal-case">{contact}</span>
                                                            <button
                                                                onClick={() => removeContact(type, contact)}
                                                                className="text-[var(--color-silica)] hover:text-[var(--color-alert)] ml-1"
                                                            >
                                                                <X className="w-3 h-3" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            <div className="flex gap-2">
                                                <input
                                                    type="email"
                                                    placeholder="ADD CONTACT EMAIL..."
                                                    value={newContact[type] || ""}
                                                    onChange={(e) => setNewContact({ ...newContact, [type]: e.target.value })}
                                                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addContact(type); } }}
                                                    className="flex-1 bg-black border border-[var(--color-iron)] text-[var(--color-data)] px-3 py-2 font-mono text-[10px] tracking-widest focus:border-[var(--color-data)] outline-none normal-case"
                                                />
                                                <button
                                                    onClick={() => addContact(type)}
                                                    className="px-3 py-2 border border-[var(--color-iron)] text-[var(--color-data)] hover:bg-[var(--color-data)] hover:text-black transition-none"
                                                >
                                                    <Plus className="w-3 h-3" />
                                                </button>
                                            </div>
                                            <p className="text-[9px] text-[var(--color-silica)] mt-1 normal-case">
                                                These people will be emailed when a {meta.label.toLowerCase()} alert is triggered.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            <div className="pt-4 flex justify-end gap-4">
                {saved && (
                    <span className="text-[10px] text-[var(--color-data)] self-center animate-pulse">
                        [ CONFIG_SAVED_SUCCESSFULLY ]
                    </span>
                )}
                <button
                    onClick={handleCommit}
                    disabled={saving}
                    className="px-6 py-3 font-bold border-[2px] border-[var(--color-alert)] text-[var(--color-alert)] bg-black hover:bg-[var(--color-alert)] hover:text-black transition-none uppercase shadow-[8px_8px_0_var(--color-alert)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-[4px_4px_0_var(--color-alert)] disabled:opacity-50"
                >
                    {saving ? "[ SAVING... ]" : "[ COMMIT_CONFIG ]"}
                </button>
            </div>
        </div>
    );
}
