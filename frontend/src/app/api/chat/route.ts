import { NextResponse } from 'next/server';

export const runtime = 'edge';

const apiKey = "AIzaSyBIzjSjDQMH3Lxi7i6hEmBnJfVWxIgEOZ4";
const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

export async function POST(req: Request) {
    try {
        const { messages } = await req.json();

        if (!messages || !Array.isArray(messages)) {
            return NextResponse.json({ error: "Messages array is required" }, { status: 400 });
        }

        // Map messages to Gemini API format
        const contents = messages.map((msg: any) => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }));

        const payload = {
            system_instruction: {
                parts: [{ text: "You are an advanced AI Analyst within an AI object detection for weapons and medical emergency detection platform. Maintain a highly professional tone in your responses. You do not use emojis. Answer in concise, natural sentences. Do not use robotic tags, brackets, or artificial status codes in your replies unless strictly relevant to code. Keep responses succinct, conversational, and operational." }]
            },
            contents: contents
        };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Gemini API Error: ${response.status} - ${errBody}`);
        }

        const data = await response.json();

        let replyText = "SYSTEM_NULL_RESPONSE";
        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content && data.candidates[0].content.parts.length > 0) {
            replyText = data.candidates[0].content.parts[0].text;
        }

        return NextResponse.json({ reply: replyText });

    } catch (error: any) {
        console.error("Error in AI Chat route:", error);
        return NextResponse.json({ error: error.message || "An error occurred during chatting" }, { status: 500 });
    }
}
