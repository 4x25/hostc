# Custom subdomains (fork)

This fork lets users choose the tunnel subdomain while the official `npx hostc` CLI stays
unmodified. Upstream behavior is untouched: with `--server` pointing at the normal API host,
tunnels still get random ids.

## Usage

Point `--server` at the subdomain instead of the API host:

```bash
npx -y hostc 3000 --server https://my-app.<TUNNEL_DOMAIN>

# Equivalent, via the environment variable the CLI supports.
HOSTC_SERVER=https://my-app.<TUNNEL_DOMAIN> npx -y hostc 3000
```

`https://my-app.<TUNNEL_DOMAIN>` is then served by the local server, and a new tunnel with the
same subdomain can be started at any time from the same client IP.

## How it works

The CLI has no subdomain option and sends no body when creating a tunnel, so the only input the
server ever sees is the `--server` URL. A request on `https://<label>.<TUNNEL_DOMAIN>` is
therefore read as "give me `<label>`":

- `apps/server/src/custom.ts` handles those requests before upstream routing. It claims the label,
  returns `201 { id: label, url, connectUrl, token }`, and forwards everything that is not the
  tunnel API to the tunnel's Durable Object.
- `apps/server/src/custom-tunnel.ts` is a `Tunnel` subclass that adds `claim(ip, nonce)` and
  refuses connects whose nonce does not match the current claim.
- Upstream `index.ts` only calls `handleCustomRequest` at the top of `fetch` and re-exports the
  subclass as `Tunnel`; everything else in the server is untouched.

## Rules

- `label` must be a DNS label (`a-z`, `0-9`, `-`; at most 63 characters) and must not look like a
  generated tunnel id (12 characters from `abcdefghijkmnpqrstuvwxyz23456789`). A hostc client
  whose `--server` names such a label gets `400`; unusable labels get upstream's not-found page.
- On a custom subdomain, `/api/health`, `/api/tunnels` and `/api/tunnels/*` are answered by the
  server. Any other path is forwarded to the tunnel, so an app route like `/api/tunnels-list`
  still works.
- A subdomain belongs to the client that claimed it (`cf-connecting-ip`, `local` in development).
  That client may claim it again at any time (a hostc restart keeps the subdomain); other clients
  get `409` while the tunnel is alive and may claim it once the tunnel has expired.
- Each claim gets a random nonce. The connect URL carries it (`.../connect?nonce=...`), the token
  is the upstream token for the synthetic id `label:nonce`, and the Durable Object checks the
  nonce, so claiming a subdomain again invalidates tokens from every earlier claim. Random
  tunnels are unaffected.
- Traffic for custom subdomains needs the same wildcard DNS record and Worker route as random
  ones; no extra deployment configuration is required.

## Caveats

- There is no authentication (upstream has none either): any client can claim any free subdomain.
- `API_DOMAIN` must not be a subdomain of `TUNNEL_DOMAIN`, or ordinary creation requests would
  claim the `api` label.
- When a tunnel expires while offline, the CLI prints "It has a new URL" even though a custom
  subdomain keeps the same URL.
