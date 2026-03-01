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

export function getPicowsWsUrl() {
    const base = getWsUrl();
    try {
        const url = new URL(base);
        // Swap port to 9001 for picows
        url.port = "9001";
        return url.toString().replace(/\/$/, "");
    } catch {
        return base;
    }
}

export async function resolveBaseUrl(url: string | number): Promise<string> {
    if (typeof url === "number") {
        const base = getBaseUrl();
        try {
            const parsed = new URL(base);
            if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
                parsed.port = url.toString();
            }
            return parsed.toString().replace(/\/$/, "");
        } catch {
            return base;
        }
    }

    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("ws://") || url.startsWith("wss://")) {
        return url;
    }
    const base = getBaseUrl();
    if (url.startsWith("/")) {
        return `${base}${url}`;
    }
    return `${base}/${url}`;
}
