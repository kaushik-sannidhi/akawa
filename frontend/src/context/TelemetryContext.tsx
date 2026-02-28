"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { getDatabase, ref, onValue, push, set, get, off } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import app, { auth } from "@/lib/firebase";

type TelemetryData = {
    scanned: number;
    anomalies: number;
    activeNodes: number;
    latency: number;
    logs: string[];
};

type TelemetryContextType = {
    telemetry: TelemetryData;
    logSysEvent: (msg: string) => void;
    updateActiveNodes: (change: number) => void;
};

const TelemetryContext = createContext<TelemetryContextType | undefined>(undefined);

export const TelemetryProvider = ({ children }: { children: ReactNode }) => {
    const [telemetry, setTelemetry] = useState<TelemetryData>({
        scanned: 0,
        anomalies: 0,
        activeNodes: 0,
        latency: 4,
        logs: [`[${new Date().toISOString().substring(0, 10)} ${new Date().toLocaleTimeString()}] AWAITING AUTHENTICATION...`]
    });

    const [dbInstance, setDbInstance] = useState<any>(null);
    const [uid, setUid] = useState<string | null>(null);

    useEffect(() => {
        const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
            if (user) {
                setUid(user.uid);
                setTelemetry(prev => ({ ...prev, logs: [`[${new Date().toISOString().substring(0, 10)} ${new Date().toLocaleTimeString()}] SECURE SESSION ESTABLISHED FOR [ ${user.uid} ]`] }));
            } else {
                setUid(null);
                setTelemetry({
                    scanned: 0,
                    anomalies: 0,
                    activeNodes: 0,
                    latency: 4,
                    logs: [`[${new Date().toISOString().substring(0, 10)} ${new Date().toLocaleTimeString()}] AWAITING AUTHENTICATION...`]
                });
            }
        });
        return () => unsubscribeAuth();
    }, []);

    useEffect(() => {
        const db = getDatabase(app);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDbInstance(db);

        if (!uid) return;

        const telemetryRef = ref(db, `telemetry/${uid}`);

        const unsubscribe = onValue(telemetryRef, (snapshot) => {
            const data = snapshot.val();
            if (data) {
                // Parse RTDB structure back to our object shape
                let newLogs: string[] = [];
                if (data.logs) {
                    if (Array.isArray(data.logs)) {
                        newLogs = data.logs.filter(Boolean); // some old RTDB gaps
                    } else if (typeof data.logs === 'object') {
                        newLogs = Object.values(data.logs); // Support nested firebase pushes
                    }
                }
                // Filter logs to only include today's logs
                const todayPrefix = `[${new Date().toISOString().substring(0, 10)}`;
                newLogs = newLogs.filter(log => typeof log === 'string' && log.startsWith(todayPrefix));

                if (newLogs.length === 0) {
                    newLogs = telemetry.logs;
                }

                setTelemetry({
                    scanned: data.scanned ?? 0,
                    anomalies: data.anomalies ?? 0,
                    activeNodes: data.activeNodes ?? 0,
                    latency: data.latency ?? Math.floor(Math.random() * (12 - 3 + 1)) + 3,
                    logs: newLogs
                });
            }
        });

        return () => off(telemetryRef, 'value', unsubscribe);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uid]);

    const logSysEvent = async (msg: string) => {
        if (!dbInstance || !uid) return;
        const logsRef = ref(dbInstance, `telemetry/${uid}/logs`);
        const todayStr = new Date().toISOString().substring(0, 10);
        const timeStr = new Date().toLocaleTimeString();
        await push(logsRef, `[${todayStr} ${timeStr}] ${msg}`);
    };

    const updateActiveNodes = async (change: number) => {
        if (!dbInstance || !uid) return;
        const nodeRef = ref(dbInstance, `telemetry/${uid}/activeNodes`);
        const snapshot = await get(nodeRef);
        const current = snapshot.val() || 0;
        await set(nodeRef, Math.max(0, current + change));
    };

    return (
        <TelemetryContext.Provider value={{ telemetry, logSysEvent, updateActiveNodes }}>
            {children}
        </TelemetryContext.Provider>
    );
};

export const useTelemetry = () => {
    const context = useContext(TelemetryContext);
    if (!context) {
        throw new Error("useTelemetry must be used within a TelemetryProvider");
    }
    return context;
};
