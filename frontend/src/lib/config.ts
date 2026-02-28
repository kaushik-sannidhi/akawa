export const getBaseUrl = () => {
    if (process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "");
    }

    // Default to the Cloudflare tunnel domain on non-local hosts
    if (typeof window !== 'undefined'
        && window.location.hostname !== 'localhost'
        && window.location.hostname !== '127.0.0.1') {
        return "https://akawa.onrender.com";
    }

    // Fallback for local development
    return "http://localhost:8000";
};

export const getWsUrl = () => {
    if (process.env.NEXT_PUBLIC_WS_URL) {
        return process.env.NEXT_PUBLIC_WS_URL.replace(/\/$/, "");
    }
    const baseUrl = getBaseUrl();
    return baseUrl
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://");
};

/**
 * Lightweight backend health probe.
 * Returns true if the backend responds within `timeoutMs`.
 */
export const checkBackendHealth = async (timeoutMs = 5000): Promise<boolean> => {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${getBaseUrl()}/api/health`, {
            signal: controller.signal,
            cache: "no-store",
        });
        clearTimeout(timer);
        return res.ok;
    } catch {
        return false;
    }
};
