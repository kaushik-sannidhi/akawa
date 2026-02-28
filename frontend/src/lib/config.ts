export const getBaseUrl = () => {
    if (process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "");
    }

    // Default to the Cloudflare tunnel in production (Vercel)
    if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
        return "https://ai.ingeniumstem.org";
    }

    // Fallback for local development
    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    return `http://${host}:8000`;
};

export const getWsUrl = () => {
    if (process.env.NEXT_PUBLIC_WS_URL) {
        return process.env.NEXT_PUBLIC_WS_URL.replace(/\/$/, "");
    }
    const baseUrl = getBaseUrl();
    if (baseUrl.startsWith("https://")) {
        return baseUrl.replace("https://", "wss://");
    } else if (baseUrl.startsWith("http://")) {
        return baseUrl.replace("http://", "ws://");
    }

    // Default to secure Cloudflare wss in production (Vercel)
    if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
        return "wss://ai.ingeniumstem.org";
    }

    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    return `ws://${host}:8000`;
};
