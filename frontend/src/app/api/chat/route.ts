import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { withSupermemory } from '@supermemory/tools/ai-sdk';

export const runtime = 'edge';

export async function POST(req: Request) {
    const { messages } = await req.json();

    const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
    });

    // Initialize the model with Supermemory's withSupermemory wrapper for Gemini
    const model = withSupermemory(
        google('gemini-1.5-pro'),
        process.env.SUPERMEMORY_API_KEY || ""
    );

    const result = await streamText({
        model,
        system: `You are a highly analytical forensic security copilot. Use your provided Supermemory tool to search recent YOLO and VLM CCTV logs to answer the guard's questions precisely. 
    Maintain a professional, operational tone. Do not use emojis. Focus on facts detected in the footage.`,
        messages,
    });

    return result.toTextStreamResponse();
}
