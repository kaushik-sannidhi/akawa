/**
 * WHIP/WHEP client library for Cloudflare Calls.
 *
 * Similar to Cloudflare Orange's approach:
 * - WHIPPublisher: captures local camera/mic, publishes via WHIP to Cloudflare SFU
 * - WHEPSubscriber: subscribes to a published stream via WHEP from Cloudflare SFU
 * - AudioStreamer: captures audio chunks and sends to backend AI via WebSocket
 *
 * The SDP exchange is proxied through our backend (keeps CF App Secret server-side).
 * TURN credentials are fetched from our /api/turn-credentials endpoint.
 *
 * Ultra-low latency path: Browser → Cloudflare TURN → Cloudflare SFU → Browser
 * No intermediate server video relay needed.
 */

import { getBaseUrl, getWsUrl } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PublisherOptions {
  streamId: string;
  deviceId?: string;         // camera device id
  audioDeviceId?: string;    // microphone device id
  videoConstraints?: MediaTrackConstraints;
  audioConstraints?: MediaTrackConstraints;
  onConnected?: (stream: MediaStream) => void;
  onError?: (err: Error) => void;
  onTrackPublished?: (tracks: any[]) => void;
}

export interface SubscriberOptions {
  streamId: string;
  onTrack?: (stream: MediaStream) => void;
  onConnected?: () => void;
  onError?: (err: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const resp = await fetch(`${getBaseUrl()}/api/turn-credentials`, { cache: "no-store" });
    if (resp.ok) {
      const data = await resp.json();
      return data.iceServers || [];
    }
  } catch (e) {
    console.warn("[WHIP/WHEP] Failed to fetch TURN credentials:", e);
  }
  // Fallback to public STUN
  return [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
  ];
}

function createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 10,
  });
}

/** Wait until ICE gathering is complete or times out. */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 3000): Promise<void> {
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

// ─────────────────────────────────────────────────────────────────────────────
// WHIPPublisher — publishes local camera/mic to Cloudflare Calls via WHIP
// ─────────────────────────────────────────────────────────────────────────────

export class WHIPPublisher {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private stopped = false;
  private options: PublisherOptions;
  private audioStreamer: AudioStreamer | null = null;

  constructor(options: PublisherOptions) {
    this.options = options;
  }

  get stream(): MediaStream | null {
    return this.localStream;
  }

  async start(): Promise<MediaStream> {
    if (this.stopped) throw new Error("WHIPPublisher already stopped");

    try {
      // 1. Get camera/mic access
      const videoConstraints: MediaTrackConstraints = {
        deviceId: this.options.deviceId ? { exact: this.options.deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        ...this.options.videoConstraints,
      };
      const audioConstraints: MediaTrackConstraints = {
        deviceId: this.options.audioDeviceId ? { exact: this.options.audioDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        ...this.options.audioConstraints,
      };

      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints,
      });

      // 2. Set up WebRTC peer connection
      const iceServers = await fetchIceServers();
      this.pc = createPeerConnection(iceServers);

      // Add all local tracks to the PC (video + audio)
      const trackNames: string[] = [];
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
        trackNames.push(track.kind); // "video" or "audio"
      }

      // 3. Create SDP offer
      const offer = await this.pc.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false,
      });
      await this.pc.setLocalDescription(offer);

      // 4. Wait for ICE gathering to complete (Trickle ICE)
      await waitForIceGathering(this.pc);

      const finalSdp = this.pc.localDescription?.sdp;
      if (!finalSdp) throw new Error("No local SDP after ICE gathering");

      // 5. Exchange SDP with backend (which proxies to Cloudflare Calls)
      const resp = await fetch(`${getBaseUrl()}/api/calls/whip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream_id: this.options.streamId,
          sdp: finalSdp,
          track_names: trackNames,
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`WHIP exchange failed: ${resp.status} ${err}`);
      }

      const data = await resp.json();
      const answerSdp = data.sdp;
      if (!answerSdp) throw new Error("No SDP answer from server");

      // 6. Set remote description (SDP answer)
      await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      // 7. Monitor connection state
      this.pc.addEventListener("connectionstatechange", () => {
        const state = this.pc?.connectionState;
        console.log(`[WHIP] Connection state: ${state}`);
        if (state === "failed" && !this.stopped) {
          this.options.onError?.(new Error("WebRTC connection failed"));
        }
      });

      this.options.onConnected?.(this.localStream);
      this.options.onTrackPublished?.(data.tracks || []);

      // 8. Start audio streaming for AI analysis
      this.audioStreamer = new AudioStreamer(this.options.streamId, this.localStream);
      this.audioStreamer.start();

      console.log(`[WHIP] Published stream ${this.options.streamId} — ${trackNames.join(", ")}`);
      return this.localStream;

    } catch (err: any) {
      this.options.onError?.(err);
      throw err;
    }
  }

  async stop() {
    this.stopped = true;

    this.audioStreamer?.stop();
    this.audioStreamer = null;

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    console.log(`[WHIP] Stopped stream ${this.options.streamId}`);
  }

  toggleMic(enabled: boolean) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHEPSubscriber — subscribes to a Cloudflare Calls stream via WHEP
// ─────────────────────────────────────────────────────────────────────────────

export class WHEPSubscriber {
  private pc: RTCPeerConnection | null = null;
  private stopped = false;
  private options: SubscriberOptions;
  private remoteStream: MediaStream;
  private viewerSessionId: string = "";

  constructor(options: SubscriberOptions) {
    this.options = options;
    this.remoteStream = new MediaStream();
  }

  async start(): Promise<MediaStream> {
    if (this.stopped) throw new Error("WHEPSubscriber already stopped");

    try {
      // 1. Set up WebRTC peer connection
      const iceServers = await fetchIceServers();
      this.pc = createPeerConnection(iceServers);

      // 2. Set up to receive both video and audio tracks
      this.pc.addTransceiver("video", { direction: "recvonly" });
      this.pc.addTransceiver("audio", { direction: "recvonly" });

      // 3. Collect incoming tracks
      this.pc.addEventListener("track", (evt) => {
        if (evt.track) {
          // Deduplicate tracks
          const existingIds = this.remoteStream.getTracks().map(t => t.id);
          if (!existingIds.includes(evt.track.id)) {
            this.remoteStream.addTrack(evt.track);
          }
        }
        this.options.onTrack?.(this.remoteStream);
        console.log(`[WHEP] Received track: ${evt.track?.kind}`);
      });

      // 4. Create SDP offer for receiving
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // 5. Wait for ICE gathering
      await waitForIceGathering(this.pc);

      const finalSdp = this.pc.localDescription?.sdp;
      if (!finalSdp) { throw new Error("No local SDP after ICE gathering"); }

      // 6. Exchange SDP with backend
      const resp = await fetch(`${getBaseUrl()}/api/calls/whep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream_id: this.options.streamId,
          sdp: finalSdp,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`WHEP exchange failed: ${resp.status} ${errText}`);
      }

      const data = await resp.json();
      const answerSdp = data.sdp;
      this.viewerSessionId = data.viewer_session_id || "";
      const requiresRenegotiation = data.requires_renegotiation || false;

      if (!answerSdp) { throw new Error("No SDP answer from server"); }

      // 7. Set remote description
      await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      // 8. Handle immediate renegotiation if required by Cloudflare Calls
      if (requiresRenegotiation && this.viewerSessionId) {
        await this._renegotiate();
      }

      // 9. Monitor connection state
      this.pc.addEventListener("connectionstatechange", () => {
        const state = this.pc?.connectionState;
        console.log(`[WHEP] Connection state: ${state}`);
        if (state === "connected") {
          this.options.onConnected?.();
        } else if (state === "failed" && !this.stopped) {
          this.options.onError?.(new Error("WebRTC connection failed"));
        }
      });

      console.log(`[WHEP] Subscribing to stream ${this.options.streamId}, viewer session: ${this.viewerSessionId}`);
      return this.remoteStream;

    } catch (err: any) {
      this.options.onError?.(err);
      throw err;
    }
  }

  /** Handle Cloudflare Calls renegotiation step */
  private async _renegotiate() {
    if (!this.pc || !this.viewerSessionId) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await waitForIceGathering(this.pc);
      const reofferSdp = this.pc.localDescription?.sdp;
      if (!reofferSdp) return;

      const resp = await fetch(`${getBaseUrl()}/api/calls/renegotiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream_id: this.options.streamId,
          viewer_session_id: this.viewerSessionId,
          sdp: reofferSdp,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.sdp) {
          await this.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
          console.log(`[WHEP] Renegotiation complete`);
        }
      }
    } catch (e) {
      console.warn("[WHEP] Renegotiation failed:", e);
    }
  }


  async stop() {
    this.stopped = true;
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    console.log(`[WHEP] Stopped subscriber for ${this.options.streamId}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AudioStreamer — captures audio and sends to backend AI via WebSocket
// ─────────────────────────────────────────────────────────────────────────────

export class AudioStreamer {
  private streamId: string;
  private mediaStream: MediaStream;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private audioChunks: Float32Array[] = [];
  private chunkTimer: ReturnType<typeof setInterval> | null = null;
  private SAMPLE_RATE = 16000;
  private CHUNK_INTERVAL_MS = 2000; // Send 2s chunks

  constructor(streamId: string, mediaStream: MediaStream) {
    this.streamId = streamId;
    this.mediaStream = mediaStream;
  }

  start() {
    this.connectWs();
    this.startCapture();
  }

  private connectWs() {
    const wsUrl = getWsUrl();
    const connect = () => {
      if (this.stopped) return;
      this.ws = new WebSocket(`${wsUrl}/ws/audio_in/${this.streamId}`);
      this.ws.binaryType = "arraybuffer";
      this.ws.onclose = () => {
        if (!this.stopped) setTimeout(connect, 3000);
      };
    };
    connect();
  }

  private startCapture() {
    try {
      this.audioContext = new AudioContext({ sampleRate: this.SAMPLE_RATE });
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Use ScriptProcessorNode for broad browser support
      // Note: AudioWorklet would be better but requires more setup
      const bufferSize = 4096;
      this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
      this.processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        this.audioChunks.push(new Float32Array(inputData));
      };
      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      // Flush chunks every CHUNK_INTERVAL_MS
      this.chunkTimer = setInterval(() => this.flushChunks(), this.CHUNK_INTERVAL_MS);
    } catch (e) {
      console.warn("[AudioStreamer] Failed to start audio capture:", e);
    }
  }

  private flushChunks() {
    if (!this.audioChunks.length || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.audioChunks = [];
      return;
    }

    // Concatenate all chunks
    const totalLength = this.audioChunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.audioChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.audioChunks = [];

    // Convert Float32 PCM to WAV bytes
    const wavBytes = this.encodeWav(combined, this.SAMPLE_RATE);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(wavBytes);
    }
  }

  private encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // WAV header
    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples.length * 2, true);

    // Convert float32 to int16
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  stop() {
    this.stopped = true;
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

