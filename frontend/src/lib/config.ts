/** Primary backend via Cloudflare Tunnel — ALWAYS tried first */
const CF_TUNNEL_URL = "https://backend.itsakawa.tech";

/** Fallback backend on Render — used only when the tunnel is unreachable */
const RENDER_URL = "https://akawa.onrender.com";

// ── Runtime resolution cache ──────────────────────────────────────────────────
let _resolvedUrl: string | null = null;
let _resolvedAt = 0;
const RESOLVE_CACHE_TTL = 60_000; // 1 minute

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Lightweight backend health probe.
 * Returns true if the backend responds within `timeoutMs`.
 */
export const checkBackendHealth = async (url: string, timeoutMs = 5000): Promise<boolean> => {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${url}/api/health`, {
            signal: controller.signal,
            cache: "no-store",
        });
        clearTimeout(timer);
        return res.ok;
    } catch {
        return false;
    }
};

// ── Sync accessors (return cached resolved URL once available) ────────────────

/**
 * Returns the best available backend base URL.
 *
 * Before the background health check completes it returns `CF_TUNNEL_URL`
 * (the Cloudflare Tunnel). Once `resolveBaseUrl()` finishes, subsequent
 * calls transparently return whichever URL is actually healthy — falling
 * back to Render only when the tunnel is down.
 */
export const getBaseUrl = (): string => {
    if (_resolvedUrl) return _resolvedUrl;
    // Before the health check resolves, always prefer the tunnel.
    return CF_TUNNEL_URL;
};

export const getWsUrl = (): string => {
    return getBaseUrl()
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://");
};

// ── Async resolution with fallback ───────────────────────────────────────────

/**
 * Resolves the best available backend URL at runtime.
 *
 * **Always** tries the Cloudflare Tunnel first; falls back to Render only
 * when the tunnel is unreachable or unhealthy. Result is cached for
 * `RESOLVE_CACHE_TTL` (60 s) to avoid probing on every request.
 */
export const resolveBaseUrl = async (timeoutMs = 4000): Promise<string> => {
    const now = Date.now();
    if (_resolvedUrl && now - _resolvedAt < RESOLVE_CACHE_TTL) {
        return _resolvedUrl;
    }

    // Always probe the Cloudflare Tunnel first, regardless of env vars.
    const tunnelOk = await checkBackendHealth(CF_TUNNEL_URL, timeoutMs);
    if (tunnelOk) {
        _resolvedUrl = CF_TUNNEL_URL;
        _resolvedAt = now;
        return _resolvedUrl;
    }

    // Tunnel is down — try Render as fallback.
    console.warn("[akawa] Cloudflare Tunnel unreachable, trying Render fallback…");
    const renderOk = await checkBackendHealth(RENDER_URL, timeoutMs);
    if (renderOk) {
        _resolvedUrl = RENDER_URL;
        _resolvedAt = now;
        return _resolvedUrl;
    }

    // Both are down — default to the tunnel (best-effort).
    console.warn("[akawa] Both backends unreachable — defaulting to Cloudflare Tunnel.");
    _resolvedUrl = CF_TUNNEL_URL;
    _resolvedAt = now;
    return _resolvedUrl;
};

/**
 * Same as resolveBaseUrl but returns a WebSocket URL (wss:// / ws://).
 */
export const resolveWsUrl = async (timeoutMs = 4000): Promise<string> => {
    const base = await resolveBaseUrl(timeoutMs);
    return base
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://");
};

// ── Background init (client-side only) ───────────────────────────────────────
// Kick off a health check as soon as this module is imported so that by the
// time the user triggers their first API call, getBaseUrl() already returns
// the right (possibly fallback) URL.
if (typeof window !== "undefined") {
    resolveBaseUrl().then((url) => {
        if (url === RENDER_URL) {
            console.info(`[akawa] Using Render fallback: ${url}`);
        } else {
            console.info(`[akawa] Using Cloudflare Tunnel: ${url}`);
        }
    });
}
