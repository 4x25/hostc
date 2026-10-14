/**
 * [fork] The tunnel Durable Object with custom-subdomain support.
 *
 * All upstream behavior lives in `./tunnel.ts`; this subclass only adds `claim` and the check
 * that a connect belongs to the current claim. Put nothing else here.
 */
import { CONNECT_URL, TUNNEL_KEY, Tunnel as UpstreamTunnel } from "./tunnel.ts";

/** Internal header carrying a claim nonce on connect; set by `connectCustomTunnel` in `./custom.ts`. */
export const CLAIM_NONCE_HEADER = "hostc-claim-nonce";

/** The record upstream stores, extended with the custom-subdomain claim. */
type TunnelRecord = { createdAt: number; ip?: string; nonce?: string };

export class Tunnel extends UpstreamTunnel {
	/**
	 * Claims a subdomain for a new tunnel. It fails while another client holds it; the client
	 * that claimed it may claim it again, so restarting hostc keeps the subdomain.
	 */
	claim(ip: string, nonce: string): Promise<boolean> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const existing = await this.ctx.storage.get<TunnelRecord>(TUNNEL_KEY);
			if (existing?.ip !== undefined && existing.ip !== ip) {
				return false;
			}
			// init() marks the object alive and arms the connect deadline; then record the claim.
			await super.init();
			await this.ctx.storage.put(TUNNEL_KEY, { createdAt: Date.now(), ip, nonce } satisfies TunnelRecord);
			return true;
		});
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.url === CONNECT_URL) {
			// A subdomain claimed again must not accept a connect from an earlier claim.
			const record = await this.ctx.storage.get<TunnelRecord>(TUNNEL_KEY);
			if (record?.nonce !== undefined && record.nonce !== request.headers.get(CLAIM_NONCE_HEADER)) {
				return Response.json({ error: "Invalid tunnel token" }, { status: 401 });
			}
		}
		return super.fetch(request);
	}
}
