/**
 * WHEP (WebRTC-HTTP Egress Protocol) client.
 *
 * Used by viewers to subscribe to a Cloudflare Stream Live Input
 * and receive a remote MediaStream via WebRTC.
 */

export interface WhepSession {
  pc: RTCPeerConnection;
  stream: MediaStream;
  /** Call to gracefully shut down the WHEP session */
  stop: () => void;
}

/**
 * Start playback from a WHEP endpoint.
 *
 * @param whepUrl  The WHEP play URL (from Cloudflare)
 * @returns WhepSession with the RTCPeerConnection, remote MediaStream, and stop()
 */
export async function startWhepPlayback(
  whepUrl: string,
): Promise<WhepSession> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle",
  });

  // We want to receive video and audio
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  // Collect remote tracks into a MediaStream
  const remoteStream = new MediaStream();
  pc.addEventListener("track", (evt) => {
    remoteStream.addTrack(evt.track);
  });

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering
  await waitForIceGathering(pc, 3000);

  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) throw new Error("Failed to create local SDP");

  // POST the SDP offer to the WHEP endpoint
  const resp = await fetch(whepUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/sdp",
    },
    body: localSdp,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WHEP playback failed: ${resp.status} ${text}`);
  }

  const answerSdp = await resp.text();
  await pc.setRemoteDescription(
    new RTCSessionDescription({ type: "answer", sdp: answerSdp }),
  );

  const stop = () => {
    pc.close();
  };

  return { pc, stream: remoteStream, stop };
}

/** Helper: wait for ICE gathering to finish or timeout */
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

