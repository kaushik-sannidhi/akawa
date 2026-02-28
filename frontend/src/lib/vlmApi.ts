import { getBaseUrl } from "./config";

export interface VLMAnalysisRequest {
    videoBlob: Blob;
    prompt?: string;
}

export interface VLMAnalysisResponse {
    text: string;
    error?: string;
}

/**
 * Sends a video blob to the backend VLM proxy (/api/vlm/analyze),
 * which forwards it to the Modal Qwen2-VL endpoint.
 * This keeps all external AI requests server-side for logging and telemetry.
 */
export async function analyzeVideoWithVLM({ videoBlob, prompt }: VLMAnalysisRequest): Promise<VLMAnalysisResponse> {
    try {
        // Convert Blob to Base64
        const buffer = await videoBlob.arrayBuffer();
        const base64String = btoa(
            new Uint8Array(buffer)
                .reduce((data, byte) => data + String.fromCharCode(byte), '')
        );

        const payload: any = {
            video_b64: base64String
        };

        if (prompt) {
            payload.prompt = prompt;
        }

        const response = await fetch(`${getBaseUrl()}/api/vlm/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data: VLMAnalysisResponse = await response.json();
        return data;
    } catch (error: any) {
        console.error("VLM Analysis Error:", error);
        return {
            text: "",
            error: error.message || "Failed to analyze video"
        };
    }
}
