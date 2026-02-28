/**
 * Supermemory Client Utility
 * Handles ingestion of security alerts and VLM descriptions into the Supermemory vector database.
 */

export interface SecurityEventParams {
    alertType: string;
    vlmDescription: string;
    timestamp: string;
    cameraId: string;
}

/**
 * Saves a security event to the Supermemory database for semantic search.
 * 
 * @param params - The security event details: type, VLM description, time, and camera ID.
 * @returns A promise that resolves when the ingestion is complete (or fails gracefully).
 */
export async function saveSecurityEventToMemory({
    alertType,
    vlmDescription,
    timestamp,
    cameraId
}: SecurityEventParams): Promise<void> {
    // Note: In Next.js, env vars intended for the client must be prefixed with NEXT_PUBLIC_.
    // However, for ingestion pipelines, it's often safer to do this via a server action 
    // or proxy if the key shouldn't be exposed. 
    // Per requirements, we use SUPERMEMORY_API_KEY from .env.local.
    const apiKey = process.env.NEXT_PUBLIC_SUPERMEMORY_API_KEY || process.env.SUPERMEMORY_API_KEY;

    if (!apiKey) {
        console.warn("[SUPERMEMORY] API Key missing. Skipping ingestion.");
        return;
    }

    // "Construct a payload where the content is the rich vlmDescription, 
    // and the metadata object contains the alertType, timestamp, and cameraId."
    const payload = {
        content: vlmDescription,
        metadata: {
            alertType,
            timestamp,
            cameraId
        }
    };

    try {
        const response = await fetch("https://api.supermemory.ai/v1/store", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[SUPERMEMORY] API Error (${response.status}):`, errorText);
        } else {
            console.log("[SUPERMEMORY] Security event successfully stored.");
        }
    } catch (error) {
        // "Include basic try/catch error handling so it doesn't crash our main event loop"
        console.error("[SUPERMEMORY] Failed to connect to Supermemory API:", error);
    }
}
