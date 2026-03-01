"use client";

import { useEffect, useState } from "react";
import { ref, get, set } from "firebase/database";
import { useAuth } from "@/context/AuthContext";
import { useTelemetry } from "@/context/TelemetryContext";
import { db } from "@/lib/firebase";
import { UserRound } from "lucide-react";

type ProfileData = {
    full_name: string;
    organization: string;
    role: string;
    phone: string;
    primary_location: string;
};

const DEFAULT_PROFILE: ProfileData = {
    full_name: "",
    organization: "",
    role: "",
    phone: "",
    primary_location: "",
};

export default function ProfilePage() {
    const { user } = useAuth();
    const { logSysEvent } = useTelemetry();
    const [profile, setProfile] = useState<ProfileData>(DEFAULT_PROFILE);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        const loadProfile = async () => {
            if (!user?.uid) {
                setLoading(false);
                return;
            }
            try {
                const snap = await get(ref(db, `profiles/${user.uid}`));
                if (snap.exists()) {
                    setProfile({ ...DEFAULT_PROFILE, ...snap.val() });
                }
            } catch (err) {
                console.error("Failed to load profile:", err);
            } finally {
                setLoading(false);
            }
        };
        loadProfile();
    }, [user?.uid]);

    const saveProfile = async () => {
        if (!user?.uid) return;
        setSaving(true);
        setSaved(false);
        try {
            await set(ref(db, `profiles/${user.uid}`), {
                ...profile,
                uid: user.uid,
                email: user.email || "",
                updated_at: new Date().toISOString(),
            });
            logSysEvent("[INFO] PROFILE UPDATED");
            setSaved(true);
            setTimeout(() => setSaved(false), 2500);
        } catch (err) {
            console.error("Failed to save profile:", err);
        } finally {
            setSaving(false);
        }
    };

    const updateField = (field: keyof ProfileData, value: string) => {
        setProfile((prev) => ({ ...prev, [field]: value }));
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8 font-mono tracking-widest text-sm uppercase text-[var(--color-data)]">
            <div className="border-b-[2px] border-[var(--color-iron)] pb-4 mb-8">
                <h1 className="text-2xl font-black">[ OPERATOR_PROFILE ]</h1>
                <p className="text-xs text-[var(--color-silica)] mt-2 border-l-[2px] border-[var(--color-data)] pl-2">
                    STORE PROFILE AND CONTACT CONTEXT USED IN SECURITY OPERATIONS.
                </p>
            </div>

            <section className="bg-black border-[2px] border-[var(--color-iron)] p-6 structure-block">
                <h2 className="text-[10px] font-bold text-[var(--color-silica)] border-b border-[var(--color-iron)] pb-2 mb-6">
                    [ PROFILE_DETAILS ]
                </h2>

                {loading ? (
                    <div className="text-[10px] text-[var(--color-silica)] animate-pulse">LOADING PROFILE...</div>
                ) : (
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <span className="font-bold text-xs">FULL NAME</span>
                                <input
                                    type="text"
                                    value={profile.full_name}
                                    onChange={(e) => updateField("full_name", e.target.value)}
                                    className="w-full bg-black border-[2px] border-[var(--color-iron)] text-[var(--color-data)] px-4 py-3 font-mono text-xs tracking-widest focus:border-[var(--color-data)] outline-none normal-case"
                                    placeholder="Jane Doe"
                                />
                            </div>

                            <div className="space-y-2">
                                <span className="font-bold text-xs">ORGANIZATION</span>
                                <input
                                    type="text"
                                    value={profile.organization}
                                    onChange={(e) => updateField("organization", e.target.value)}
                                    className="w-full bg-black border-[2px] border-[var(--color-iron)] text-[var(--color-data)] px-4 py-3 font-mono text-xs tracking-widest focus:border-[var(--color-data)] outline-none normal-case"
                                    placeholder="Acme Security"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <span className="font-bold text-xs">ROLE</span>
                                <input
                                    type="text"
                                    value={profile.role}
                                    onChange={(e) => updateField("role", e.target.value)}
                                    className="w-full bg-black border-[2px] border-[var(--color-iron)] text-[var(--color-data)] px-4 py-3 font-mono text-xs tracking-widest focus:border-[var(--color-data)] outline-none normal-case"
                                    placeholder="Security Operator"
                                />
                            </div>

                            <div className="space-y-2">
                                <span className="font-bold text-xs">PHONE</span>
                                <input
                                    type="text"
                                    value={profile.phone}
                                    onChange={(e) => updateField("phone", e.target.value)}
                                    className="w-full bg-black border-[2px] border-[var(--color-iron)] text-[var(--color-data)] px-4 py-3 font-mono text-xs tracking-widest focus:border-[var(--color-data)] outline-none normal-case"
                                    placeholder="+1 555 123 4567"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <span className="font-bold text-xs">PRIMARY LOCATION</span>
                            <input
                                type="text"
                                value={profile.primary_location}
                                onChange={(e) => updateField("primary_location", e.target.value)}
                                className="w-full bg-black border-[2px] border-[var(--color-iron)] text-[var(--color-data)] px-4 py-3 font-mono text-xs tracking-widest focus:border-[var(--color-data)] outline-none normal-case"
                                placeholder="Main Campus Control Room"
                            />
                        </div>

                        <div className="border border-[var(--color-iron)] bg-[var(--color-dim)] p-3 flex items-start gap-3">
                            <UserRound className="w-4 h-4 mt-0.5 text-[var(--color-silica)]" />
                            <div className="text-[10px] text-[var(--color-silica)] normal-case">
                                Profile data is stored per user and can be used for downstream workflows and report metadata.
                            </div>
                        </div>
                    </div>
                )}
            </section>

            <div className="pt-4 flex justify-end gap-4">
                {saved && (
                    <span className="text-[10px] text-[var(--color-data)] self-center animate-pulse">
                        [ PROFILE_SAVED ]
                    </span>
                )}
                <button
                    onClick={saveProfile}
                    disabled={saving || loading}
                    className="px-6 py-3 font-bold border-[2px] border-[var(--color-alert)] text-[var(--color-alert)] bg-black hover:bg-[var(--color-alert)] hover:text-black transition-none uppercase shadow-[8px_8px_0_var(--color-alert)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-[4px_4px_0_var(--color-alert)] disabled:opacity-50"
                >
                    {saving ? "[ SAVING... ]" : "[ SAVE_PROFILE ]"}
                </button>
            </div>
        </div>
    );
}
