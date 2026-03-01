export function getBaseUrl() {
    if (typeof window !== "undefined") {
        const host = window.location.hostname;
        if (host === "localhost" || host === "127.0.0.1") {
            return `http://${host}:8000`;
        }
    }
    return "https://akawa.ingeniumstem.org";
}

export function getWsUrl(path: string = "") {
    if (typeof window !== "undefined") {
        const host = window.location.hostname;
        if (host === "localhost" || host === "127.0.0.1") {
            const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            return `${protocol}//${host}:8000${path}`;
        }
    }
    return `wss://akawa.ingeniumstem.org${path}`;
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
