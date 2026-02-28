"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { auth, db } from "@/lib/firebase";
import { ref, get, set } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";

// Alert type configuration
export type AlertTypeConfig = {
    email: boolean;
    telegram: boolean;
    contacts: string[];
};

export type AlertTypesMap = {
    gun: AlertTypeConfig;
    knife: AlertTypeConfig;
    fall: AlertTypeConfig;
    fight: AlertTypeConfig;
};

export type NotificationSettings = {
    email: string;
    telegram_id: string;
    email_enabled: boolean;
    telegram_enabled: boolean;
    alert_types: AlertTypesMap;
};

const DEFAULT_ALERT_TYPE: AlertTypeConfig = { email: true, telegram: false, contacts: [] };

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
    email: "",
    telegram_id: "",
    email_enabled: true,
    telegram_enabled: false,
    alert_types: {
        gun: { email: true, telegram: false, contacts: [] },
        knife: { email: true, telegram: false, contacts: [] },
        fall: { email: true, telegram: false, contacts: [] },
        fight: { email: true, telegram: false, contacts: [] },
    },
};

type SettingsContextType = {
    confidenceThreshold: number;
    setConfidenceThreshold: (v: number) => void;
    selectedModel: string;
    setSelectedModel: (v: string) => void;
    notificationSettings: NotificationSettings;
    setNotificationSettings: (v: NotificationSettings) => void;
    saveNotificationSettings: (settings?: NotificationSettings) => Promise<void>;
    notificationsLoaded: boolean;
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

const STORAGE_KEY = "akawa_settings";

function loadSettings() {
    if (typeof window === "undefined") return { confidenceThreshold: 0.65, selectedModel: "latest" };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                confidenceThreshold: parsed.confidenceThreshold ?? 0.65,
                selectedModel: parsed.selectedModel ?? "latest",
            };
        }
    } catch { }
    return { confidenceThreshold: 0.65, selectedModel: "latest" };
}

function saveSettings(settings: { confidenceThreshold: number; selectedModel: string }) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { }
}

export const SettingsProvider = ({ children }: { children: ReactNode }) => {
    const [confidenceThreshold, setConfidenceThresholdRaw] = useState(0.65);
    const [selectedModel, setSelectedModelRaw] = useState("latest");
    const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
    const [notificationsLoaded, setNotificationsLoaded] = useState(false);

    useEffect(() => {
        const saved = loadSettings();
        setConfidenceThresholdRaw(saved.confidenceThreshold);
        setSelectedModelRaw(saved.selectedModel);
    }, []);

    // Load notification settings from Firebase when user is authenticated
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                try {
                    const configRef = ref(db, `alerts_config/${user.uid}`);
                    const snapshot = await get(configRef);
                    if (snapshot.exists()) {
                        const data = snapshot.val();
                        setNotificationSettings({
                            email: data.email || user.email || "",
                            telegram_id: data.telegram_id || "",
                            email_enabled: data.email_enabled ?? true,
                            telegram_enabled: data.telegram_enabled ?? false,
                            alert_types: {
                                gun: { ...DEFAULT_ALERT_TYPE, ...data.alert_types?.gun },
                                knife: { ...DEFAULT_ALERT_TYPE, ...data.alert_types?.knife },
                                fall: { ...DEFAULT_ALERT_TYPE, ...data.alert_types?.fall },
                                fight: { ...DEFAULT_ALERT_TYPE, ...data.alert_types?.fight },
                            },
                        });
                    } else {
                        setNotificationSettings({
                            ...DEFAULT_NOTIFICATION_SETTINGS,
                            email: user.email || "",
                        });
                    }
                } catch (err) {
                    console.error("Failed to load notification settings:", err);
                }
                setNotificationsLoaded(true);
            }
        });
        return () => unsubscribe();
    }, []);

    const saveNotificationSettings = async (settings?: NotificationSettings) => {
        const toSave = settings || notificationSettings;
        const uid = auth.currentUser?.uid;
        if (!uid) return;
        try {
            const configRef = ref(db, `alerts_config/${uid}`);
            await set(configRef, {
                ...toSave,
                updated_at: new Date().toISOString(),
            });
        } catch (err) {
            console.error("Failed to save notification settings:", err);
        }
    };

    const setConfidenceThreshold = (v: number) => {
        setConfidenceThresholdRaw(v);
        saveSettings({ confidenceThreshold: v, selectedModel });
    };

    const setSelectedModel = (v: string) => {
        setSelectedModelRaw(v);
        saveSettings({ confidenceThreshold, selectedModel: v });
    };

    return (
        <SettingsContext.Provider value={{
            confidenceThreshold, setConfidenceThreshold,
            selectedModel, setSelectedModel,
            notificationSettings, setNotificationSettings,
            saveNotificationSettings, notificationsLoaded,
        }}>
            {children}
        </SettingsContext.Provider>
    );
};

export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (!context) {
        throw new Error("useSettings must be used within a SettingsProvider");
    }
    return context;
};
