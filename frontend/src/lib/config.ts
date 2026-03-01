export const getBaseUrl = () => {

    // Fallback for local development
    return "akawa-production.up.railway.app";
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
