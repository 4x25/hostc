/** [fork] Tests for custom subdomains; upstream tests stay in `./tunnel.test.ts`. */
import { type CreateTunnelResponse, decodeOpen, FrameType, PROTOCOL_HEADER, PROTOCOL_VERSION } from "@hostc/protocol";
import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { signConnectToken } from "../src/token.ts";
import { connect, createTunnel, PROTOCOL, publicUrl } from "./helpers.ts";

describe("custom subdomains", () => {
	function createAt(label: string, ip: string): Promise<Response> {
		return SELF.fetch(`https://${label}.tunnel.test/api/tunnels`, {
			method: "POST",
			headers: { ...PROTOCOL, "cf-connecting-ip": ip },
		});
	}

	async function createCustom(label: string, ip = "203.0.113.50"): Promise<CreateTunnelResponse> {
		const response = await createAt(label, ip);
		if (response.status !== 201) {
			throw new Error(`create failed: ${response.status} ${await response.text()}`);
		}
		return (await response.json()) as CreateTunnelResponse;
	}

	it("serves a tunnel at the requested subdomain", async () => {
		const tunnel = await createCustom("my-app");
		expect(tunnel.id).toBe("my-app");
		expect(tunnel.url).toBe("https://my-app.tunnel.test");
		expect(tunnel.connectUrl).toMatch(
			/^wss:\/\/my-app\.tunnel\.test\/api\/tunnels\/my-app\/connect\?nonce=[0-9a-f-]{36}$/,
		);

		const client = await connect(tunnel);
		const pending = SELF.fetch(publicUrl(tunnel, "/hello"));
		const open = await client.next((frame) => frame.type === FrameType.Open);
		expect(decodeOpen(open.payload).path).toBe("/hello");
		client.head(open.stream, { body: false });
		expect((await pending).status).toBe(200);
	});

	it("requires the current protocol version on custom subdomains", async () => {
		const response = await SELF.fetch("https://old-client.tunnel.test/api/tunnels", {
			method: "POST",
			headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION - 1), "cf-connecting-ip": "203.0.113.60" },
		});
		expect(response.status).toBe(426);
	});

	it("answers the API health check on custom subdomains", async () => {
		const response = await SELF.fetch("https://health-check.tunnel.test/api/health");
		expect(await response.json()).toEqual({ ok: true });
	});

	it("keeps a live subdomain for the client that claimed it", async () => {
		await createCustom("taken", "203.0.113.51");
		expect((await createAt("taken", "203.0.113.52")).status).toBe(409);
	});

	it("lets the claiming client claim the subdomain again", async () => {
		await createCustom("restart", "203.0.113.53");
		expect((await createAt("restart", "203.0.113.53")).status).toBe(201);
	});

	it("invalidates tokens from an earlier claim", async () => {
		const first = await createCustom("rotating", "203.0.113.57");
		const response = await createAt("rotating", "203.0.113.57");
		expect(response.status).toBe(201);
		const second = (await response.json()) as CreateTunnelResponse;
		expect(second.token).not.toBe(first.token);

		const stale = await SELF.fetch(first.connectUrl.replace(/^ws/, "http"), {
			headers: { upgrade: "websocket", authorization: `Bearer ${first.token}`, ...PROTOCOL },
		});
		expect(stale.status).toBe(401);

		const client = await connect(second);
		const pending = SELF.fetch(publicUrl(second));
		const open = await client.next((frame) => frame.type === FrameType.Open);
		client.head(open.stream, { body: false });
		expect((await pending).status).toBe(200);
	});

	it("frees the subdomain when the tunnel expires", async () => {
		const tunnel = await createCustom("expiring", "203.0.113.54");
		expect(await runDurableObjectAlarm(env.TUNNEL.getByName(tunnel.id))).toBe(true);
		expect((await SELF.fetch(publicUrl(tunnel))).status).toBe(404);
		expect((await createAt("expiring", "203.0.113.55")).status).toBe(201);
	});

	it("rejects labels that look like generated tunnel ids", async () => {
		const response = await createAt("abcdefghijkm", "203.0.113.56");
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining("generated tunnel id") });
	});

	it("rejects labels that are not DNS-safe", async () => {
		for (const label of ["-bad-", "under_score", "a.b"]) {
			const response = await SELF.fetch(`https://${label}.tunnel.test/`);
			expect(response.status).toBe(404);
		}
	});

	it("rejects a token that was not issued for the claim", async () => {
		const nonce = crypto.randomUUID();
		const response = await SELF.fetch(
			`https://wrong-token.tunnel.test/api/tunnels/wrong-token/connect?nonce=${nonce}`,
			{
				headers: {
					upgrade: "websocket",
					authorization: `Bearer ${await signConnectToken(env.TOKEN_SECRET, "wrong-token")}`,
					...PROTOCOL,
				},
			},
		);
		expect(response.status).toBe(401);
	});

	it("requires the claim nonce to connect", async () => {
		const response = await SELF.fetch("https://nonce-less.tunnel.test/api/tunnels/nonce-less/connect", {
			headers: { upgrade: "websocket", authorization: "Bearer whatever", ...PROTOCOL },
		});
		expect(response.status).toBe(401);
	});

	it("treats a trailing dot as the same host", async () => {
		const response = await SELF.fetch("https://dotted.tunnel.test./api/tunnels", {
			method: "POST",
			headers: { ...PROTOCOL, "cf-connecting-ip": "203.0.113.61" },
		});
		expect(response.status).toBe(201);
		expect(((await response.json()) as CreateTunnelResponse).id).toBe("dotted");
	});

	it("accepts a non-default port next to the label", async () => {
		const response = await SELF.fetch("https://ported.tunnel.test:8443/api/tunnels", {
			method: "POST",
			headers: { ...PROTOCOL, "cf-connecting-ip": "203.0.113.62" },
		});
		expect(response.status).toBe(201);
		const tunnel = (await response.json()) as CreateTunnelResponse;
		expect(tunnel.id).toBe("ported");
		expect(tunnel.url).toBe("https://ported.tunnel.test:8443");
	});

	it("accepts a trailing dot before a non-default port", async () => {
		const response = await SELF.fetch("https://dotted-port.tunnel.test.:8443/api/tunnels", {
			method: "POST",
			headers: { ...PROTOCOL, "cf-connecting-ip": "203.0.113.63" },
		});
		expect(response.status).toBe(201);
		const tunnel = (await response.json()) as CreateTunnelResponse;
		expect(tunnel.id).toBe("dotted-port");
		expect(tunnel.url).toBe("https://dotted-port.tunnel.test:8443");
	});

	it("leaves paths that only start like an API path to the app", async () => {
		const tunnel = await createCustom("api-app");
		const client = await connect(tunnel);
		const pending = SELF.fetch(publicUrl(tunnel, "/api/tunnels-list"));
		const open = await client.next((frame) => frame.type === FrameType.Open);
		expect(decodeOpen(open.payload).path).toBe("/api/tunnels-list");
		client.head(open.stream, { body: false });
		expect((await pending).status).toBe(200);
	});

	it("still proxies API paths on generated-id hosts", async () => {
		const tunnel = await createTunnel();
		const client = await connect(tunnel);
		const pending = SELF.fetch(publicUrl(tunnel, "/api/tunnels"), { method: "POST" });
		const open = await client.next((frame) => frame.type === FrameType.Open);
		expect(decodeOpen(open.payload)).toMatchObject({ method: "POST", path: "/api/tunnels" });
		client.head(open.stream, { body: false });
		expect((await pending).status).toBe(200);
	});
});
