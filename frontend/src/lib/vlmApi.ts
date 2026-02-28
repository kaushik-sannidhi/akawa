export interface VLMAnalysisRequest {
    videoBlob: Blob;
    prompt?: string;
}

export interface VLMAnalysisResponse {
    text: string;
    error?: string;
}

const MODAL_ENDPOINT = "https://apat7--akawa-vlm-api-qwen2vlmodel-analyze.modal.run";

/**
 * Sends a video blob to the Modal Qwen2-VL endpoint for analysis.
 * Converts the Blob to a base64 string, strips the data URL prefix,
 * and sends it as JSON.
 */
export async function analyzeVideoWithVLM({ videoBlob, prompt }: VLMAnalysisRequest): Promise<VLMAnalysisResponse> {
    try {
        // Convert Blob to Base64
        const buffer = await videoBlob.arrayBuffer();
        const base64String = btoa(
            new Uint8Array(buffer)
                .reduce((data, byte) => data + String.fromCharCode(byte), '')
        );

        // Prepare payload according to Qwen2VLRequest schema
        const payload: any = {
            video_b64: base64String
        };
        
        if (prompt) {
            payload.prompt = prompt;
        }

        const response = await fetch(MODAL_ENDPOINT, {
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
