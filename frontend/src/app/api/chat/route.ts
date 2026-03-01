/**
 * /api/chat – Security Copilot chat route
 *
 * Flow:
 *  1. Fetch recent security reports from Firebase (via the backend API)
 *  2. Optionally search Supermemory for relevant context
 *  3. Call the Modal Akawa LLM endpoint with enriched prompt
 *  4. Return the cleaned response
 */

const MODAL_LLM_URL =
    "https://apat7--akawa-llm-intelligence-akawaintelligence-generate-report.modal.run";

// Backend API base — same machine during dev
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

// Firebase RTDB for direct alert reads (fallback if backend is down)
const FIREBASE_RTDB_URL =
    process.env.FIREBASE_RTDB_URL ||
    "https://uiuc-24fae-default-rtdb.firebaseio.com";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function fetchRecentAlerts(): Promise<string> {
    // Try the Firebase RTDB directly — grab recent live events and reports
    try {
        // Fetch live events (most recent alerts from all users)
        const eventsResp = await fetch(
            `${FIREBASE_RTDB_URL}/live_events.json?orderBy="$key"&limitToLast=20`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (eventsResp.ok) {
            const raw = await eventsResp.json();
            if (raw && typeof raw === "object") {
                const entries: string[] = [];
                // raw is { uid: { event_id: { ... } } }
                for (const uid of Object.keys(raw)) {
                    const userEvents = raw[uid];
                    if (!userEvents || typeof userEvents !== "object") continue;
                    for (const evtId of Object.keys(userEvents)) {
                        const evt = userEvents[evtId];
                        if (!evt) continue;
                        const classes = (evt.classes || []).join(", ");
                        const ts = evt.timestamp
                            ? new Date(
                                typeof evt.timestamp === "number" && evt.timestamp < 1e12
                                    ? evt.timestamp * 1000
                                    : evt.timestamp
                            ).toISOString()
                            : "unknown";
                        const cam = evt.stream_id || evt.camera_id || "unknown";
                        entries.push(
                            `- [${ts}] Camera ${cam}: ${classes} (conf: ${evt.max_confidence ?? "N/A"})`
                        );
                    }
                }
                if (entries.length > 0) {
                    return `RECENT SECURITY EVENTS FROM FIREBASE:\n${entries.slice(0, 15).join("\n")}`;
                }
            }
        }
    } catch {
        // Non-fatal
    }

    // Also try to fetch reports
    try {
        const reportsResp = await fetch(
            `${FIREBASE_RTDB_URL}/reports.json?orderBy="$key"&limitToLast=10`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (reportsResp.ok) {
            const raw = await reportsResp.json();
            if (raw && typeof raw === "object") {
                const entries: string[] = [];
                for (const uid of Object.keys(raw)) {
                    const userReports = raw[uid];
                    if (!userReports || typeof userReports !== "object") continue;
                    for (const rId of Object.keys(userReports)) {
                        const r = userReports[rId];
                        if (!r) continue;
                        const ts = r.timestamp
                            ? new Date(
                                typeof r.timestamp === "number" && r.timestamp < 1e12
                                    ? r.timestamp * 1000
                                    : r.timestamp
                            ).toISOString()
                            : "unknown";
                        entries.push(
                            `- [${ts}] ${r.threat_type?.toUpperCase() || "THREAT"}: ${r.title || "Incident"} | Camera: ${r.camera_name || "N/A"} | Confidence: ${r.confidence ? Math.round(r.confidence * 100) + "%" : "N/A"} | AI Analysis: ${(r.vlm_summary || "").trim()}`
                        );
                    }
                }
                if (entries.length > 0) {
                    return `RECENT INCIDENT REPORTS:\n${entries.slice(0, 10).join("\n")}`;
                }
            }
        }
    } catch {
        // Non-fatal
    }

    return "";
}

async function searchSupermemory(query: string): Promise<string> {
    const smApiKey = process.env.SUPERMEMORY_API_KEY;
    const smContainer = process.env.SUPERMEMORY_CONTAINER_KEY;
    if (!smApiKey || !query) return "";

    try {
        const payload: any = { q: query, limit: 5 };
        if (smContainer) payload.containerTags = [smContainer];

        const resp = await fetch("https://api.supermemory.ai/v3/search", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${smApiKey}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(6000),
        });

        if (!resp.ok) return "";

        const data = await resp.json();
        const results = data?.results || data?.data || [];
        if (!Array.isArray(results) || results.length === 0) return "";

        const entries = results.map((r: any, i: number) => {
            const content = r.content || r.memory || r.chunk || r.text || "";
            const meta = r.metadata || {};
            const parts = [content.slice(0, 300)];
            if (meta.alertType) parts.push(`Alert: ${meta.alertType}`);
            if (meta.timestamp) parts.push(`Time: ${meta.timestamp}`);
            if (meta.cameraId) parts.push(`Camera: ${meta.cameraId}`);
            return `[${i + 1}] ${parts.join(" | ")}`;
        });

        return `SUPERMEMORY CONTEXT:\n${entries.join("\n")}`;
    } catch {
        return "";
    }
}

function cleanModalResponse(rawText: string): string {
    let clean = rawText;

    // Extract text after the last COPILOT/ASSISTANT marker (check longest first)
    const markers = ["ASSISTANTFINAL.", "ASSISTANTFINAL", "ASSISTANT FINAL:", "ASSISTANT:", "COPILOT:"];
    for (const marker of markers) {
        const idx = rawText.toUpperCase().lastIndexOf(marker);
        if (idx !== -1) {
            clean = rawText.substring(idx + marker.length).trim();
            break;
        }
    }

    // Strip trailing JSON metadata
    const jsonTrailIdx = clean.search(/[",]\s*"(tokens_used|processing_time|model)/i);
    if (jsonTrailIdx > 0) {
        clean = clean.substring(0, jsonTrailIdx).trim();
    }

    // Remove wrapping quotes
    if (clean.startsWith('"') && clean.endsWith('"')) {
        clean = clean.slice(1, -1);
    }

    return clean.trim() || rawText;
}

// ─── route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
    const { messages } = await req.json();
    const latestUserMsg =
        [...messages].reverse().find((m: any) => m.role === "user")?.content || "";

    // Fetch context in parallel — Firebase alerts + Supermemory
    const [firebaseContext, supermemoryContext] = await Promise.all([
        fetchRecentAlerts(),
        searchSupermemory(latestUserMsg),
    ]);

    const contextBlock = [firebaseContext, supermemoryContext]
        .filter(Boolean)
        .join("\n\n");

    // Build the LLM prompt
    const systemPrompt = `You are a friendly and helpful security assistant for the AKAWA surveillance system. You talk like a knowledgeable colleague — clear, calm, and conversational. Keep it natural.

CONTEXT — here is the latest data from our security system:
${contextBlock || "No recent alerts in the system right now."}

HOW TO RESPOND:
- STRICT FACTUAL ACCURACY: You must ONLY provide facts from the CONTEXT above. Do not hallucinate, guess, or make up any details. If the context doesn't have the answer, say you don't know.
- TONE & STYLE: Talk naturally, like a friendly and helpful security colleague briefing a teammate. You are a chatbot, so be engaging and collaborative. Avoid being robotic or overly formal.
- DETAIL: Provide comprehensive and detailed answers based on the context. Don't worry about being too brief—if there's a lot of data, summarize it clearly but don't cut off important details.
- When mentioning incidents, ALWAYS include the exact time (e.g. "at 1:34:22 PM today") and camera ID naturally in the narrative.
- COMPREHENSIVE ANALYSIS: Incorporate the full VLM AI Analysis details to explain exactly what was seen (e.g. specific movements, objects, or behaviors).
- FORMATTING: Use bold, lists, or headers where appropriate to make your detailed report easy to read, but keep the overall feel conversational.`;

    const { GoogleGenerativeAI } = require("@google/generative-ai");

    // Call Gemini with a timeout
    try {
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (!apiKey) {
            return Response.json(
                { role: "assistant", content: "[SYSTEM] Error: GEMINI_API_KEY is not set in environment." },
                { status: 200 }
            );
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            systemInstruction: systemPrompt,
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 2048,
            }
        });

        const geminiMessages = messages.map((m: any) => ({
            role: m.role === "user" ? "user" : "model",
            parts: [{ text: m.content }]
        }));

        const result = await model.generateContent({ contents: geminiMessages });
        const cleanText = result.response.text();

        return Response.json({ role: "assistant", content: cleanText });
    } catch (err: any) {
        const errorMsg = `Communication error: ${err.message}`;

        return Response.json(
            { role: "assistant", content: `[SYSTEM] ${errorMsg}` },
            { status: 200 }
        );
    }
}
