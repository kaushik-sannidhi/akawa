/**
 * WHIP (WebRTC-HTTP Ingestion Protocol) client.
 *
 * Used by camera owners to publish their local MediaStream to a
 * Cloudflare Stream Live Input via WebRTC.
 */

export interface WhipSession {
  pc: RTCPeerConnection;
  /** Call to gracefully shut down the WHIP session */
  stop: () => void;
}

/**
 * Start publishing a MediaStream to a WHIP endpoint.
 *
 * @param mediaStream  The local camera/mic MediaStream
 * @param whipUrl      The WHIP publish URL (from Cloudflare)
 * @returns WhipSession with the RTCPeerConnection and a stop function
 */
export async function startWhipPublish(
  mediaStream: MediaStream,
  whipUrl: string,
): Promise<WhipSession> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle",
  });

  // Add all tracks (video + optional audio)
  mediaStream.getTracks().forEach((track) => {
    pc.addTransceiver(track, { direction: "sendonly" });
  });

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to complete (or timeout after 3s)
  await waitForIceGathering(pc, 3000);

  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) throw new Error("Failed to create local SDP");

  // POST the SDP offer to the WHIP endpoint
  const resp = await fetch(whipUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/sdp",
    },
    body: localSdp,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WHIP publish failed: ${resp.status} ${text}`);
  }

  const answerSdp = await resp.text();
  await pc.setRemoteDescription(
    new RTCSessionDescription({ type: "answer", sdp: answerSdp }),
  );

  const stop = () => {
    pc.close();
  };

  return { pc, stop };
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

