/**
 * Cloudflare Realtime Kit client.
 *
 * Uses the official @cloudflare/realtimekit SDK to join meetings,
 * publish camera, and subscribe to remote participants.
 * All WebRTC, TURN, ICE, reconnection, etc. is handled by the SDK.
 */

import { CloudflareRealtimeKit } from "@cloudflare/realtimekit";
import { getBaseUrl } from "@/lib/config";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RealtimeSession {
  meeting: CloudflareRealtimeKit;
  /** Call to leave the meeting and cleanup */
  stop: () => Promise<void>;
}

// ─── Join a meeting (works for both publishers and viewers) ──────────────────

/**
 * Request an auth token from the backend and initialize the Realtime Kit SDK.
 * The SDK automatically handles:
 *   - WebRTC connection with Cloudflare's global SFU
 *   - TURN/ICE for NAT traversal across networks
 *   - Automatic reconnection
 *   - Audio + Video tracks
 */
export async function joinMeeting(
  streamId: string,
  participantName: string,
  deviceId: string,
): Promise<RealtimeSession> {
  // 1. Get auth token from backend
  const resp = await fetch(`${getBaseUrl()}/api/realtime/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream_id: streamId,
      participant_name: participantName,
      device_id: deviceId,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to join meeting: ${resp.status} ${text}`);
  }

  const { auth_token } = await resp.json();
  if (!auth_token) throw new Error("No auth token returned from backend");

  // 2. Initialize the Realtime Kit SDK with the auth token
  const meeting = await CloudflareRealtimeKit.init({ authToken: auth_token });

  // 3. Join the meeting room
  await meeting.joinRoom();

  return {
    meeting,
    stop: async () => {
      try {
        await meeting.leaveRoom();
      } catch {
        // ignore leave errors on cleanup
      }
    },
  };
}

/**
 * Enable the local camera + mic and start publishing to the meeting.
 * Call this after joinMeeting() for the camera owner.
 */
export async function enableLocalMedia(meeting: CloudflareRealtimeKit): Promise<void> {
  await meeting.self.enableVideo();
  await meeting.self.enableAudio();
}

/**
 * Disable local media (stop publishing).
 */
export async function disableLocalMedia(meeting: CloudflareRealtimeKit): Promise<void> {
  await meeting.self.disableVideo();
  await meeting.self.disableAudio();
}
