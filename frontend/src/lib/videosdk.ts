/**
 * VideoSDK configuration for live camera streaming.
 *
 * Uses VideoSDK's Video Conferencing API:
 *  - Each camera stream = one VideoSDK "room"
 *  - Camera owner joins room with webcam + mic enabled
 *  - Viewers join the same roomId to watch
 *  - VideoSDK handles all WebRTC, TURN/STUN, NAT traversal
 */

export const VIDEOSDK_TOKEN = "b89621c5-a89e-4d6e-8391-68711bcad2b7";

/**
 * Create a new VideoSDK room for a camera stream.
 * Returns the unique roomId.
 */
export async function createVideoSDKRoom(): Promise<string> {
    const res = await fetch("https://api.videosdk.live/v2/rooms", {
        method: "POST",
        headers: {
            authorization: VIDEOSDK_TOKEN,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    });

    if (!res.ok) {
        throw new Error(`VideoSDK room creation failed: ${res.status}`);
    }

    const { roomId } = await res.json();
    return roomId;
}
