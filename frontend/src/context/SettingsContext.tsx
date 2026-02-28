"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";

type SettingsContextType = {
    confidenceThreshold: number;
    setConfidenceThreshold: (v: number) => void;
    selectedModel: string;
    setSelectedModel: (v: string) => void;
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

const STORAGE_KEY = "aegis_settings";

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

    useEffect(() => {
        const saved = loadSettings();
        setConfidenceThresholdRaw(saved.confidenceThreshold);
        setSelectedModelRaw(saved.selectedModel);
    }, []);

    const setConfidenceThreshold = (v: number) => {
        setConfidenceThresholdRaw(v);
        saveSettings({ confidenceThreshold: v, selectedModel });
    };

    const setSelectedModel = (v: string) => {
        setSelectedModelRaw(v);
        saveSettings({ confidenceThreshold, selectedModel: v });
    };

    return (
        <SettingsContext.Provider value={{ confidenceThreshold, setConfidenceThreshold, selectedModel, setSelectedModel }}>
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
