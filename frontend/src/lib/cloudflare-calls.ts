import { getBaseUrl } from "@/lib/config";

export type RealtimeJoinRole = "publisher" | "viewer";

export interface RealtimeJoinRequest {
  streamId: string;
  participantName: string;
  deviceId: string;
  role: RealtimeJoinRole;
}

export interface RealtimeJoinResult {
  authToken: string;
  participantId: string;
  meetingId: string;
  role: RealtimeJoinRole;
}

export async function requestRealtimeJoin(
  payload: RealtimeJoinRequest,
): Promise<RealtimeJoinResult> {
  const response = await fetch(`${getBaseUrl()}/api/realtime/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      stream_id: payload.streamId,
      participant_name: payload.participantName,
      device_id: payload.deviceId,
      role: payload.role,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Realtime join failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`Realtime join failed: ${data.error}`);
  }

  if (!data.auth_token || !data.meeting_id || !data.participant_id) {
    throw new Error("Realtime join response missing required fields");
  }

  return {
    authToken: data.auth_token,
    participantId: data.participant_id,
    meetingId: data.meeting_id,
    role: data.role === "publisher" ? "publisher" : "viewer",
  };
}
