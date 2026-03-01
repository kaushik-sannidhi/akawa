const DEFAULT_PROD_BACKEND = "https://akawa.ingeniumstem.org";

function normalizeBase(url: string): string {
    return url.replace(/\/$/, "");
}

export function getBaseUrl() {
    // Always use the production backend domain so reports and APIs
    // consistently hit the deployed FastAPI instance.
    return normalizeBase(DEFAULT_PROD_BACKEND);
}

export function getWsUrl(path: string = "") {
    const base = getBaseUrl();
    try {
        const url = new URL(base);
        // Upgrade http/https to ws/wss
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        if (path) {
            const cleanPath = path.startsWith("/") ? path : `/${path}`;
            url.pathname = `${url.pathname.replace(/\/$/, "")}${cleanPath}`;
        }
        return url.toString().replace(/\/$/, "");
    } catch {
        // Fallback: manually swap scheme
        const cleaned = base.replace(/^https?:\/\//, "");
        const scheme = base.startsWith("https") ? "wss" : "ws";
        const cleanPath = path ? (path.startsWith("/") ? path : `/${path}`) : "";
        return `${scheme}://${cleaned}${cleanPath}`;
    }
}

export function getPicowsWsUrl() {
    const base = getWsUrl();
    try {
        const url = new URL(base);
        // Swap port to 9001 for picows while preserving host/scheme
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
