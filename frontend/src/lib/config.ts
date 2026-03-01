export function getBaseUrl() {
    if (typeof window !== "undefined") {
        return process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    }
    return process.env.NEXT_PUBLIC_API_URL || process.env.BACKEND_URL || "http://localhost:8000";
}

export function getWsUrl() {
    if (typeof window !== "undefined") {
        return process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000";
    }
    return process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000";
}

export function resolveBaseUrl(url: string) {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("ws://") || url.startsWith("wss://")) {
        return url;
    }
    const base = getBaseUrl();
    if (url.startsWith("/")) {
        return `${base}${url}`;
    }
    return `${base}/${url}`;
}
