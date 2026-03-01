/** Primary backend via Cloudflare Tunnel */
const CF_TUNNEL_URL = "https://backend.itsakawa.tech";

/** Fallback backend on Render */
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
 * On first call it returns the env-configured or default (tunnel) URL.
 * After the background health check resolves (a few seconds after page load),
 * subsequent calls return the health-checked URL — automatically switching to
 * the Render fallback if the Cloudflare Tunnel is down.
 */
export const getBaseUrl = () => {
    if (_resolvedUrl) return _resolvedUrl;
    if (process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "");
    }
    return CF_TUNNEL_URL;
};

export const getWsUrl = () => {
    if (process.env.NEXT_PUBLIC_WS_URL) {
        return process.env.NEXT_PUBLIC_WS_URL.replace(/\/$/, "");
    }
    return getBaseUrl()
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://");
};

// ── Async resolution with fallback ───────────────────────────────────────────

/**
 * Resolves the best available backend URL at runtime.
 * Tries the primary URL first (Cloudflare Tunnel by default); falls back to
 * the other endpoint if the primary is unreachable.
 * Result is cached for RESOLVE_CACHE_TTL to avoid repeated probing.
 */
export const resolveBaseUrl = async (timeoutMs = 4000): Promise<string> => {
    const now = Date.now();
    if (_resolvedUrl && now - _resolvedAt < RESOLVE_CACHE_TTL) {
        return _resolvedUrl;
    }

    // getBaseUrl() returns env var or CF_TUNNEL_URL (no cache yet during probe)
    const envUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? CF_TUNNEL_URL;
    const fallback = envUrl === RENDER_URL ? CF_TUNNEL_URL : RENDER_URL;

    const primaryOk = await checkBackendHealth(envUrl, timeoutMs);
    if (primaryOk) {
        _resolvedUrl = envUrl;
        _resolvedAt = now;
        return _resolvedUrl;
    }

    const fallbackOk = await checkBackendHealth(fallback, timeoutMs);
    _resolvedUrl = fallbackOk ? fallback : envUrl; // best-effort even if both fail
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
        const configured = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? CF_TUNNEL_URL;
        if (url !== configured) {
            console.info(`[akawa] Cloudflare Tunnel unavailable — falling back to: ${url}`);
        }
    });
}
