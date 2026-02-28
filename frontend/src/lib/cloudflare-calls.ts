/**
 * Cloudflare Realtime Kit client.
 *
 * Uses the official @cloudflare/realtimekit SDK to join meetings,
 * publish camera, and subscribe to remote participants.
 * All WebRTC, TURN, ICE, reconnection, etc. is handled by the SDK.
 */

import CloudflareRealtimeKit from "@cloudflare/realtimekit";
import type { RTKSelf, RTKParticipant } from "@cloudflare/realtimekit";
import { getBaseUrl } from "@/lib/config";

// Re-export types the rest of the app needs
export type { RTKSelf, RTKParticipant };
export type RTKClient = CloudflareRealtimeKit;

export interface RealtimeSession {
  meeting: CloudflareRealtimeKit;
  /** Call to leave the meeting and cleanup */
  stop: () => Promise<void>;
}

/**
 * Request an auth token from the backend and initialise the Realtime Kit SDK.
 * Works for both publishers and viewers — the SDK handles everything.
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
