export function getBaseUrl() {
    if (typeof window !== "undefined") {
        return process.env.NEXT_PUBLIC_API_URL || "https://akawa.ingeniumstem.org";
    }
    return process.env.NEXT_PUBLIC_API_URL || process.env.BACKEND_URL || "https://akawa.ingeniumstem.org";
}

export function getWsUrl() {
    if (typeof window !== "undefined") {
        return process.env.NEXT_PUBLIC_WS_URL || "wss://akawa.ingeniumstem.org";
    }
    return process.env.NEXT_PUBLIC_WS_URL || "wss://akawa.ingeniumstem.org";
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
