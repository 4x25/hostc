/**
 * [fork] Custom subdomains for the unmodified official `npx hostc` CLI.
 *
 * The CLI sends no subdomain anywhere, so the only user-controlled input the server sees is the
 * `--server` URL: a request on `https://<label>.<TUNNEL_DOMAIN>` means "give me `<label>`".
 * Everything the fork adds lives in this file (and `./custom-tunnel.ts`); `index.ts` only calls
 * `handleCustomRequest` before its own routing, and returns whatever it does not handle.
 */
import {
	API_TUNNELS_PATH,
	type CreateTunnelResponse,
	isTunnelId,
	PROTOCOL_HEADER,
	PROTOCOL_VERSION,
} from "@hostc/protocol";

import { CLAIM_NONCE_HEADER } from "./custom-tunnel.ts";
import { signConnectToken, verifyConnectToken } from "./token.ts";
import { CONNECT_URL } from "./tunnel.ts";

const NONCE_PARAM = "nonce";

/** A client-chosen subdomain: a DNS label that can never collide with a generated tunnel id. */
function isCustomLabel(label: string): boolean {
	return !isTunnelId(label) && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

/**
 * The label a request is addressed to.
 * `undefined` when the host is not under the tunnel domain,
 * `null` when it is but the label is neither a generated id nor a valid custom label
 * (upstream answers those with its not-found page).
 */
export function labelFromHost(host: string, tunnelDomain: string): string | null | undefined {
	const suffix = `.${tunnelDomain.toLowerCase().replace(/\.$/, "")}`;
	// A non-default port (`https://demo.hostc.app:8443`) and a trailing dot (the absolute-DNS
	// form) do not take part in the label; TUNNEL_DOMAIN carries its own port when it has one.
	const normalized = host.toLowerCase();
	const withoutPort = normalized.endsWith(suffix) ? normalized : normalized.replace(/:\d+$/, "");
	const candidate = withoutPort.replace(/\.$/, "");
	if (!candidate.endsWith(suffix)) {
		return undefined;
	}
	const label = candidate.slice(0, -suffix.length);
	return isTunnelId(label) || isCustomLabel(label) ? label : null;
}

/**
 * Handles what the fork adds; `undefined` for requests upstream should route (normal API hosts,
 * generated-id hosts, unusable labels, and non-API paths on custom subdomains are handled here).
 */
export async function handleCustomRequest(request: Request, env: Env, url: URL): Promise<Response | undefined> {
	const label = labelFromHost(url.host, env.TUNNEL_DOMAIN);
	if (label === undefined || label === null) {
		return undefined;
	}
	if (isTunnelId(label)) {
		// Generated-id hosts keep upstream routing. A client pointed at such a label with
		// `--server` cannot claim it, so say that instead of proxying a creation request.
		if (request.method === "POST" && url.pathname === API_TUNNELS_PATH && request.headers.has(PROTOCOL_HEADER)) {
			return jsonError(400, "A tunnel subdomain must not look like a generated tunnel id. Choose a different one.");
		}
		return undefined;
	}

	// The API must answer on the custom subdomain: `--server https://<label>.<TUNNEL_DOMAIN>` is
	// the only way the unmodified official CLI can ask for one. Only exact API paths are
	// reserved; something like `/api/tunnels-list` belongs to the app.
	if (url.pathname === "/api/health") {
		return Response.json({ ok: true });
	}
	if (url.pathname === API_TUNNELS_PATH || url.pathname.startsWith(`${API_TUNNELS_PATH}/`)) {
		if (request.headers.get(PROTOCOL_HEADER) !== String(PROTOCOL_VERSION)) {
			return jsonError(426, "This hostc version is not supported by the server. Run `npx hostc@latest` to upgrade.");
		}
		if (url.pathname === API_TUNNELS_PATH) {
			return request.method === "POST"
				? createCustomTunnel(request, env, url, label)
				: jsonError(405, "Method not allowed");
		}
		const connect = url.pathname.match(/^\/api\/tunnels\/([^/]+)\/connect$/);
		if (connect?.[1] === label) {
			return connectCustomTunnel(request, env, label, url);
		}
		return jsonError(404, "Not found");
	}

	return env.TUNNEL.getByName(label).fetch(request);
}

/** Like `createTunnel` in `./index.ts`, for a client-chosen label. */
async function createCustomTunnel(request: Request, env: Env, url: URL, label: string): Promise<Response> {
	const client = request.headers.get("cf-connecting-ip") ?? "local";
	const { success } = await env.CREATE_LIMIT.limit({ key: client });
	if (!success) {
		return jsonError(429, "Too many tunnels created. Try again in a minute.");
	}

	const nonce = crypto.randomUUID();
	if (!(await env.TUNNEL.getByName(label).claim(client, nonce))) {
		return jsonError(409, `The subdomain "${label}" is already in use.`);
	}

	const connectUrl = new URL(`${API_TUNNELS_PATH}/${label}/connect`, url);
	connectUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	connectUrl.searchParams.set(NONCE_PARAM, nonce);
	const body: CreateTunnelResponse = {
		id: label,
		// A trailing dot is never part of an origin (a browser's origin has none).
		url: url.origin.replace(/\.(?=:|$)/, ""),
		connectUrl: connectUrl.toString(),
		// The upstream token for the synthetic id "<label>:<nonce>"; Durable Objects never see it.
		token: await signConnectToken(env.TOKEN_SECRET, claimId(label, nonce)),
	};
	return Response.json(body, { status: 201 });
}

/** Like `connectTunnel` in `./index.ts`, for a client-chosen label. */
async function connectCustomTunnel(request: Request, env: Env, label: string, url: URL): Promise<Response> {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return jsonError(426, "Expected a WebSocket upgrade");
	}
	const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
	const nonce = url.searchParams.get(NONCE_PARAM);
	if (!token || !nonce || !(await verifyConnectToken(env.TOKEN_SECRET, claimId(label, nonce), token))) {
		return jsonError(401, "Invalid tunnel token");
	}
	const forwarded = new Request(CONNECT_URL, request);
	forwarded.headers.set(CLAIM_NONCE_HEADER, nonce);
	return env.TUNNEL.getByName(label).fetch(forwarded);
}

function claimId(label: string, nonce: string): string {
	return `${label}:${nonce}`;
}

function jsonError(status: number, error: string): Response {
	return Response.json({ error }, { status });
}
