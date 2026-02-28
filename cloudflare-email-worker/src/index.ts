/**
 * Akawa Email Worker — Cloudflare Worker for sending security alert emails.
 *
 * Uses Resend (https://resend.com) for transactional email delivery.
 * Free tier: 3,000 emails/month, 100/day — more than enough for alerts.
 *
 * Setup:
 *   1. Sign up at https://resend.com and get an API key
 *   2. Add your domain (itsakawa.tech) or use the free onboarding@resend.dev sender
 *   3. Set the secret:  npx wrangler secret put RESEND_API_KEY
 *   4. Deploy:          npm run deploy
 *
 * Endpoints:
 *   POST /send
 *     Headers: { "X-Worker-Secret": "<WORKER_SECRET>" }
 *     Body:    { "to": ["email@example.com"], "subject": "...", "body": "...", "html": "..." }
 *
 *   GET  /health
 *     Returns { "status": "ok" }
 */

export interface Env {
	FROM_EMAIL: string;
	FROM_NAME: string;
	WORKER_SECRET: string;
	RESEND_API_KEY: string; // set via: npx wrangler secret put RESEND_API_KEY
}

interface EmailRequest {
	to: string[];
	subject: string;
	body: string;
	html?: string;
}

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, X-Worker-Secret",
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// ── CORS preflight ──
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: CORS_HEADERS });
		}

		const url = new URL(request.url);

		// ── Health check ──
		if (url.pathname === "/health" || url.pathname === "/") {
			return json({ status: "ok", service: "akawa-email-worker" });
		}

		// ── Send endpoint ──
		if (url.pathname === "/send") {
			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, 405);
			}

			// Auth
			const secret = request.headers.get("X-Worker-Secret");
			if (secret !== env.WORKER_SECRET) {
				return json({ error: "Unauthorized" }, 401);
			}

			// Parse body
			let payload: EmailRequest;
			try {
				payload = (await request.json()) as EmailRequest;
			} catch {
				return json({ error: "Invalid JSON body" }, 400);
			}

			if (!payload.to || payload.to.length === 0 || !payload.subject) {
				return json({ error: "Missing required fields: to, subject" }, 400);
			}

			// Check Resend key is configured
			if (!env.RESEND_API_KEY) {
				return json({ error: "RESEND_API_KEY not configured. Run: npx wrangler secret put RESEND_API_KEY" }, 500);
			}

			// Send to each recipient via Resend
			const results: { email: string; success: boolean; error?: string }[] = [];

			for (const recipient of payload.to) {
				try {
					const resendResp = await fetch("https://api.resend.com/emails", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.RESEND_API_KEY}`,
						},
						body: JSON.stringify({
							from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
							to: [recipient],
							subject: payload.subject,
							...(payload.html ? { html: payload.html } : { text: payload.body }),
						}),
					});

					if (resendResp.ok) {
						const data = (await resendResp.json()) as { id?: string };
						results.push({ email: recipient, success: true, error: undefined });
					} else {
						const errBody = await resendResp.text();
						results.push({
							email: recipient,
							success: false,
							error: `Resend ${resendResp.status}: ${errBody.slice(0, 200)}`,
						});
					}
				} catch (e: any) {
					results.push({
						email: recipient,
						success: false,
						error: e.message || String(e),
					});
				}
			}

			const allOk = results.every((r) => r.success);
			return json({ ok: allOk, results }, allOk ? 200 : 207);
		}

		return json({ error: "Not found" }, 404);
	},
};

/** Helper: return JSON response with CORS headers */
function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}
