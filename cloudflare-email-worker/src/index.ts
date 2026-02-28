/**
 * Akawa Email Worker — Cloudflare Worker for sending alert emails
 * via MailChannels API (free transactional email through Cloudflare Workers).
 *
 * POST /send
 * Headers: { "X-Worker-Secret": "<WORKER_SECRET>" }
 * Body:    { "to": ["email@example.com"], "subject": "...", "body": "...", "html": "..." }
 */

export interface Env {
	FROM_EMAIL: string;
	FROM_NAME: string;
	WORKER_SECRET: string;
}

interface EmailRequest {
	to: string[];
	subject: string;
	body: string;
	html?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, X-Worker-Secret",
				},
			});
		}

		if (request.method !== "POST") {
			return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
		}

		const url = new URL(request.url);
		if (url.pathname !== "/send") {
			return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
		}

		// Auth check
		const secret = request.headers.get("X-Worker-Secret");
		if (secret !== env.WORKER_SECRET) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
		}

		let payload: EmailRequest;
		try {
			payload = await request.json() as EmailRequest;
		} catch {
			return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
		}

		if (!payload.to || payload.to.length === 0 || !payload.subject) {
			return new Response(JSON.stringify({ error: "Missing required fields: to, subject" }), { status: 400 });
		}

		const results: { email: string; success: boolean; error?: string }[] = [];

		for (const recipient of payload.to) {
			try {
				const mailRequest = new Request("https://api.mailchannels.net/tx/v1/send", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						personalizations: [
							{
								to: [{ email: recipient }],
							},
						],
						from: {
							email: env.FROM_EMAIL,
							name: env.FROM_NAME,
						},
						subject: payload.subject,
						content: [
							payload.html
								? { type: "text/html", value: payload.html }
								: { type: "text/plain", value: payload.body },
						],
					}),
				});

				const resp = await fetch(mailRequest);

				if (resp.status === 202 || resp.status === 200) {
					results.push({ email: recipient, success: true });
				} else {
					const errText = await resp.text();
					results.push({ email: recipient, success: false, error: `${resp.status}: ${errText}` });
				}
			} catch (e: any) {
				results.push({ email: recipient, success: false, error: e.message || String(e) });
			}
		}

		return new Response(JSON.stringify({ results }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			},
		});
	},
};

