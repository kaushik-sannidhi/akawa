/**
 * VideoSDK helpers.
 *
 * All credentials live on the backend — the frontend only fetches a JWT
 * token and creates rooms via backend proxy endpoints so the API secret
 * is never exposed to the browser.
 */

import { getBaseUrl } from "./config";

let _cachedToken: string | null = null;
let _tokenFetchedAt = 0;

/**
 * Get a VideoSDK JWT token (cached for 1 hour).
 */
export async function getVideoSDKToken(): Promise<string> {
    const now = Date.now();
    // Re-use cached token for up to 1 hour
    if (_cachedToken && now - _tokenFetchedAt < 3600_000) {
        return _cachedToken;
    }

    const res = await fetch(`${getBaseUrl()}/api/videosdk/token`);
    if (!res.ok) throw new Error(`Failed to fetch VideoSDK token: ${res.status}`);
    const { token } = await res.json();
    _cachedToken = token;
    _tokenFetchedAt = now;
    return token;
}

/**
 * Create a new VideoSDK room via the backend (keeps API key server-side).
 */
export async function createVideoSDKRoom(): Promise<string> {
    const res = await fetch(`${getBaseUrl()}/api/videosdk/room`, {
        method: "POST",
    });
    if (!res.ok) throw new Error(`VideoSDK room creation failed: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.roomId;
}
