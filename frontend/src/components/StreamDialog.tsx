"use client";

import { useState, useEffect } from "react";
import { Camera, Monitor, Globe, X } from "lucide-react";
import { getBaseUrl } from "@/lib/config";
import { useAuth } from "@/context/AuthContext";

interface StreamDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onStreamAdded: (stream?: any) => void;
}

export default function StreamDialog({ isOpen, onClose, onStreamAdded }: StreamDialogProps) {
    const { user } = useAuth();
    const [name, setName] = useState("");
    const [streamType, setStreamType] = useState<"rtsp" | "server_cam" | "client_cam">("server_cam");
    const [source, setSource] = useState("0");
    const [loading, setLoading] = useState(false);
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

    useEffect(() => {
        if (streamType === "client_cam") {
            const getDevices = async () => {
                try {
                    // Ask permission briefly to get labels
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                    stream.getTracks().forEach(t => t.stop());

                    const devs = await navigator.mediaDevices.enumerateDevices();
                    const videoDevs = devs.filter(d => d.kind === "videoinput");
                    setDevices(videoDevs);

                    if (videoDevs.length > 0) {
                        setSource(videoDevs[0].deviceId);
                    } else {
                        setSource("local");
                    }
                } catch (err) {
                    console.error("Failed to list devices", err);
                    setSource("local");
                }
            };
            getDevices();
        } else if (streamType === "server_cam") {
            setSource("0");
        } else {
            setSource("");
        }
    }, [streamType]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        let deviceId = localStorage.getItem("device_id");
        if (!deviceId) {
            deviceId = Math.random().toString(36).substring(2, 15);
            localStorage.setItem("device_id", deviceId);
        }

        try {
            if (!user?.uid) {
                throw new Error("AUTH_REQUIRED");
            }

            const uid = user.uid;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(`${getBaseUrl()}/api/streams`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name,
                    stream_type: streamType,
                    source,
                    uid,
                    model_id: "latest",
                    device_id: deviceId
                }),
                signal: controller.signal,
            });
            clearTimeout(timer);

            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(errorText);
            }

            const data = await res.json();
            onStreamAdded(data?.stream);
            onClose();
        } catch (err) {
            console.error("Failed to add stream", err);
            alert("Error adding stream");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-3 sm:p-4">
            <div className="bg-[#0A0A0A] border-[2px] border-[var(--color-iron)] p-4 sm:p-6 w-full max-w-md font-mono uppercase text-white shadow-[8px_8px_0_var(--color-iron)] max-h-[90dvh] overflow-y-auto">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="font-bold text-lg border-b-[2px] border-white pb-1">[ DEPLOY_NEW_SENSOR ]</h2>
                    <button onClick={onClose} className="hover:text-[var(--color-alert)] p-1">
                        <X className="w-6 h-6" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-[var(--color-silica)]">SENSOR_ALIAS</label>
                        <input
                            type="text"
                            required
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="MAIN_GATE_01"
                            className="bg-black border-[2px] border-[var(--color-iron)] p-2 text-white focus:border-[var(--color-data)] outline-none"
                        />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-[var(--color-silica)]">SENSOR_TOPOLOGY</label>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <button
                                type="button"
                                onClick={() => setStreamType("server_cam")}
                                className={`p-2 border-[2px] text-[10px] font-bold flex flex-col items-center gap-2 ${streamType === "server_cam" ? "bg-[var(--color-data)] border-[var(--color-data)] text-black" : "border-[var(--color-iron)] hover:border-[var(--color-silica)] bg-black"}`}
                            >
                                <Monitor className="w-5 h-5" /> SERVER_CAM
                            </button>
                            <button
                                type="button"
                                onClick={() => setStreamType("rtsp")}
                                className={`p-2 border-[2px] text-[10px] font-bold flex flex-col items-center gap-2 ${streamType === "rtsp" ? "bg-[var(--color-data)] border-[var(--color-data)] text-black" : "border-[var(--color-iron)] hover:border-[var(--color-silica)] bg-black"}`}
                            >
                                <Globe className="w-5 h-5" /> RTSP_IP_CAM
                            </button>
                            <button
                                type="button"
                                onClick={() => setStreamType("client_cam")}
                                className={`p-2 border-[2px] text-[10px] font-bold flex flex-col items-center gap-2 ${streamType === "client_cam" ? "bg-[var(--color-data)] border-[var(--color-data)] text-black" : "border-[var(--color-iron)] hover:border-[var(--color-silica)] bg-black"}`}
                            >
                                <Camera className="w-5 h-5" /> LOCAL_DEVICE
                            </button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-[var(--color-silica)]">
                            {streamType === "client_cam" ? "SELECT_DEVICE" : "URI_OR_INDEX"}
                        </label>
                        {streamType === "client_cam" ? (
                            <select
                                required
                                value={source}
                                onChange={e => setSource(e.target.value)}
                                className="bg-black border-[2px] border-[var(--color-iron)] p-2 text-white outline-none focus:border-[var(--color-data)] text-xs"
                            >
                                {devices.map(d => (
                                    <option key={d.deviceId} value={d.deviceId}>
                                        {d.label || `CAMERA_${d.deviceId.substring(0, 8)}`}
                                    </option>
                                ))}
                                {devices.length === 0 && <option value="local">LOCAL_DEFAULT</option>}
                            </select>
                        ) : (
                            <input
                                type="text"
                                required
                                value={source}
                                onChange={e => setSource(e.target.value)}
                                placeholder={streamType === "server_cam" ? "0" : "rtsp://..."}
                                className="bg-black border-[2px] border-[var(--color-iron)] p-2 text-white outline-none focus:border-[var(--color-data)]"
                            />
                        )}
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="mt-4 p-3 bg-white text-black font-bold border-[2px] border-white hover:bg-black hover:text-white transition-colors disabled:opacity-50"
                    >
                        {loading ? "INITIALIZING..." : "[ ACTIVATE_NODE ]"}
                    </button>
                </form>
            </div>
        </div>
    );
}
