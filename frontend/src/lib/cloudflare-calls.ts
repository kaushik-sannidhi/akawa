/**
 * Cloudflare Calls (Realtime SFU) + TURN client.
 *
 * Publisher: creates a session, pushes video track to the SFU
 * Viewer:   creates a session, pulls the publisher's track from the SFU
 *
 * All signaling goes through our backend API which proxies to Cloudflare Calls.
 * TURN credentials are fetched from the backend for NAT traversal.
 */

import { getBaseUrl } from "@/lib/config";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CallsSession {
  pc: RTCPeerConnection;
  sessionId: string;
  stop: () => void;
}

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ─── TURN / ICE credentials ─────────────────────────────────────────────────

let cachedIceServers: IceServerConfig[] | null = null;
let cacheExpiry = 0;

async function getIceServers(): Promise<IceServerConfig[]> {
  if (cachedIceServers && Date.now() < cacheExpiry) return cachedIceServers!;

  try {
    const resp = await fetch(`${getBaseUrl()}/api/turn-credentials`, {
      cache: "no-store",
    });
    if (resp.ok) {
      const data = await resp.json();
      const servers: IceServerConfig[] = data.iceServers || [];
      cachedIceServers = servers;
      cacheExpiry = Date.now() + 12 * 3600 * 1000; // cache 12h
      return servers;
    }
  } catch (e) {
    console.warn("[Calls] Failed to fetch TURN credentials:", e);
  }

  // Fallback: STUN only
  return [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
  ];
}

// ─── Publisher (push track to SFU) ──────────────────────────────────────────

/**
 * Publish a local MediaStream to a Cloudflare Calls session.
 *
 * 1. Uses the existing session ID (created when stream was created on backend)
 *    or creates a new one if needed
 * 2. Creates an RTCPeerConnection with TURN credentials
 * 3. Adds the video track as sendonly
 * 4. Sends the SDP offer to the backend → Cloudflare Calls SFU
 * 5. Sets the SDP answer from the SFU
 */
export async function publishToCalls(
  mediaStream: MediaStream,
  streamId: string,
  existingSessionId?: string,
): Promise<CallsSession> {
  const iceServers = await getIceServers();

  // 1. Use existing session or create a new one
  let sessionId = existingSessionId || "";
  if (!sessionId) {
    const sessionResp = await fetch(`${getBaseUrl()}/api/calls/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId }),
    });
    if (!sessionResp.ok) throw new Error(`Session create failed: ${sessionResp.status}`);
    const data = await sessionResp.json();
    sessionId = data.sessionId;
  }

  // 2. Create PeerConnection with TURN
  const pc = new RTCPeerConnection({
    iceServers,
    bundlePolicy: "max-bundle",
  });

  // 3. Add video track as sendonly
  const videoTrack = mediaStream.getVideoTracks()[0];
  if (videoTrack) {
    pc.addTransceiver(videoTrack, { direction: "sendonly" });
  }
  // Optionally add audio
  const audioTrack = mediaStream.getAudioTracks()[0];
  if (audioTrack) {
    pc.addTransceiver(audioTrack, { direction: "sendonly" });
  }

  // 4. Create offer and gather ICE candidates
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc, 3000);

  const localSdp = pc.localDescription!.sdp;

  // 5. Send SDP offer to backend → Cloudflare Calls push_track
  const pushResp = await fetch(`${getBaseUrl()}/api/calls/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream_id: streamId,
      session_id: sessionId,
      sdp_offer: localSdp,
      track_name: `video-${streamId}`,
    }),
  });
  if (!pushResp.ok) throw new Error(`Push track failed: ${pushResp.status}`);
  const pushData = await pushResp.json();

  // 6. Set remote answer from SFU
  if (pushData.sdp_answer) {
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: pushData.sdp_answer }),
    );
  }

  // Handle renegotiation if required
  if (pushData.requiresImmediateRenegotiation) {
    const reOffer = await pc.createOffer();
    await pc.setLocalDescription(reOffer);
    await waitForIceGathering(pc, 2000);

    const reResp = await fetch(`${getBaseUrl()}/api/calls/renegotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        sdp_offer: pc.localDescription!.sdp,
      }),
    });
    if (reResp.ok) {
      const reData = await reResp.json();
      if (reData.sdp_answer) {
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: reData.sdp_answer }),
        );
      }
    }
  }

  return {
    pc,
    sessionId,
    stop: () => pc.close(),
  };
}

// ─── Viewer (pull track from SFU) ───────────────────────────────────────────

/**
 * Subscribe to a publisher's track from Cloudflare Calls SFU.
 *
 * Returns a MediaStream that can be attached to a <video> element.
 */
export async function viewFromCalls(
  streamId: string,
  publisherSessionId: string,
): Promise<CallsSession & { remoteStream: MediaStream }> {
  const iceServers = await getIceServers();

  // 1. Create a viewer session
  const sessionResp = await fetch(`${getBaseUrl()}/api/calls/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream_id: streamId }),
  });
  if (!sessionResp.ok) throw new Error(`Viewer session create failed: ${sessionResp.status}`);
  const { sessionId } = await sessionResp.json();

  // 2. Create PeerConnection
  const pc = new RTCPeerConnection({
    iceServers,
    bundlePolicy: "max-bundle",
  });

  // Collect remote tracks
  const remoteStream = new MediaStream();
  pc.addEventListener("track", (evt) => {
    remoteStream.addTrack(evt.track);
  });

  // 3. Add recvonly transceiver
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  // 4. Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc, 3000);

  const localSdp = pc.localDescription!.sdp;

  // 5. Send to backend → Cloudflare Calls pull_track
  const pullResp = await fetch(`${getBaseUrl()}/api/calls/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream_id: streamId,
      session_id: sessionId,
      publisher_session_id: publisherSessionId,
      sdp_offer: localSdp,
      track_name: `video-${streamId}`,
    }),
  });
  if (!pullResp.ok) throw new Error(`Pull track failed: ${pullResp.status}`);
  const pullData = await pullResp.json();

  // 6. Set remote answer
  if (pullData.sdp_answer) {
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: pullData.sdp_answer }),
    );
  }

  // Handle renegotiation
  if (pullData.requiresImmediateRenegotiation) {
    const reOffer = await pc.createOffer();
    await pc.setLocalDescription(reOffer);
    await waitForIceGathering(pc, 2000);

    const reResp = await fetch(`${getBaseUrl()}/api/calls/renegotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        sdp_offer: pc.localDescription!.sdp,
      }),
    });
    if (reResp.ok) {
      const reData = await reResp.json();
      if (reData.sdp_answer) {
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: reData.sdp_answer }),
        );
      }
    }
  }

  return {
    pc,
    sessionId,
    remoteStream,
    stop: () => pc.close(),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

