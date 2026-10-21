# Remote access, pairing and tunnels

## Access from your phone (no domain needed)

The installer and `citadel qr` print a scannable one-time pairing QR code, and **Settings → Connection** shows a fresh pairing code. The encoded address is chosen automatically: an explicit `CITADEL_PUBLIC_URL`, otherwise an active **Cloudflare Quick Tunnel**, otherwise a **Tailscale** `*.ts.net` address, otherwise the LAN IP (which only works on the same Wi-Fi).

The same code does both jobs: scanning it with any camera app opens the panel, while scanning it from another Citadel's **Pair a machine** screen pairs the two hosts. **Settings → Connection** always shows a fresh single-use pairing code (it expires in 10 minutes); use **New code** to generate another one.

> **Camera on a phone:** the live in-browser camera requires HTTPS (or `localhost`). When the panel is opened over plain HTTP, or in a browser without live QR support, pairing still works with **Take a photo of the QR** (native camera capture) or by pasting the link.

## Switching between paired machines

The machine selector above the sidebar lists this host plus every paired machine with a live status dot. **Pair a machine…** accepts a scanned or pasted code:

1. On machine A: open **Settings → Connection** to show the dual-purpose QR.
2. On machine B: sidebar → machine selector → **Pair a machine…**, then scan the code (live camera or photo) or paste its link.
3. Both sides store each other. Use the selector to jump between them; the browser URL never changes.

Pairing stores a stable instance id and **every candidate address** the host reports. A Cloudflare Quick Tunnel URL changes on every restart, so paired hosts re-announce their current addresses right after boot and every five minutes; the proxy tries each candidate until one answers. If an address is stale, the next announcement repairs it — no re-pairing needed. Because every peer request and response carries the sender's identity and current addresses, a single successful call in either direction repairs both sides. The browser also caches addresses it has seen and syncs them back on load, which covers the case where only the panel's own tunnel rotated. Unpair from **Settings → Machines** (or the selector's **Manage machines…**): it always removes the machine locally, and revokes the token on the remote side when that machine can be reached.

Peer credentials are separate per direction: the inbound token is stored only as a SHA-256 hash, the outbound token is encrypted at rest with the existing vault key, and neither is ever exposed to the browser. Pairing links carry the secret in the URL fragment (`#pair=…`), so it is not sent to the server or written to proxy logs.

## Credentials follow the pairing

A pairing code created in **Settings → Connection** (the startup/installer QR does not, as it has no administrator attached) also merges the encrypted credential vault in both directions: environment variables, GitHub/GitLab tokens and the other vault entries (SSH keys, files). The merge runs server-to-server with the paired peer token, so values never reach the browser. The newest `updated_at` wins, equal values are skipped, and deletions stay local. For safety it only runs over HTTPS (or loopback); pairing over a plain-HTTP LAN address still succeeds but skips the merge. Use **Settings → Machines → Sync credentials** to merge again after adding or rotating a token.

## Stable URL on your own domain (named tunnel)

With a domain on Cloudflare (e.g. `citadel.example.com`): in Zero Trust → Networks → Tunnels create a tunnel, add a *Public hostname* pointing to `http://localhost:3000`, and copy its token. Then:

```bash
citadel tunnel --domain=citadel.example.com --token=<TOKEN>
citadel tunnel --quick     # back to a random trycloudflare.com URL
```

**From the panel:** run `sudo citadel tunnel setup` once (installs `cloudflared` and a scoped root helper; the installer already does it), then open **Settings → Tunnel (your own domain)**, enter the hostname and click *Connect domain*. You authorize once in Cloudflare and the panel creates the tunnel, the DNS record and starts the service; the login certificate is deleted afterwards and only the tunnel token is kept.

The URL survives restarts and reboots, and the panel, QR and pairing use it automatically. The token is stored in `data/tunnel-token` (mode 600).

## Global URL with a Cloudflare Quick Tunnel (no account, no domain)

To reach the panel from **any network with a single command**, start a Cloudflare Quick Tunnel:

```bash
citadel tunnel          # installs cloudflared, starts the tunnel, prints the URL + QR
citadel tunnel stop     # stop it
citadel tunnel remove   # stop and delete the service
```

It gives you a public `https://<random>.trycloudflare.com` URL that works everywhere. The installer no longer starts it by default: pass `--tunnel` at install time, or run `citadel tunnel` afterwards. The URL **changes on every restart**, so the panel reads it dynamically and the QR always shows the current one (no need to touch `.env`). If two machines are paired **only** through Quick Tunnels and both restart at the same time, neither can reach the other until one address is supplied again (switch to that panel once, or enter the new address in Settings → Machines). Giving at least one machine a stable address — Tailscale, a named tunnel or `CITADEL_PUBLIC_URL` — makes recovery fully automatic. Because it is a **public** URL, create your administrator account before starting the tunnel and use a strong password.

A Quick Tunnel URL is disposable: when `cloudflared` disconnects or restarts, the old hostname stops working permanently and is not reassigned to you. Nothing is lost — the panel simply follows the URL currently written to `data/tunnel-url` — but bookmarks, phone home-screen shortcuts and the old QR stop working. For a stable address use one of these instead:

- **Tailscale** (recommended for a personal laptop): stable `https://<host>.<tailnet>.ts.net`, no public exposure, no domain or port forwarding.
- **Named Cloudflare Tunnel**: create a tunnel and DNS route for a domain you own (`cloudflared tunnel login`, `cloudflared tunnel create citadel`, `cloudflared tunnel route dns citadel citadel.example.com`), run it as a service, then set `CITADEL_PUBLIC_URL=https://citadel.example.com` in `.env` and restart Citadel.
- **VPS with a public IP**: point a DNS record at the VPS, put Caddy/Nginx with TLS in front of `127.0.0.1:3000`, and set `CITADEL_PUBLIC_URL` to that HTTPS address. Do not expose port 3000 directly over plain HTTP.

On a laptop, 24/7 mode is enabled during installation by default. Run `sudo citadel power on` to re-enable it later if it was disabled. A laptop behind NAT should use Tailscale or a named tunnel rather than depending on a Quick Tunnel URL.


To reach the panel privately instead (only your own devices), use Tailscale. **Settings → Network & access → Tailscale** is a step-by-step wizard for it: it checks that Tailscale is installed and signed in (showing the sign-in link or the exact `sudo tailscale up` command), then **Enable private address** publishes the panel on your tailnet with `tailscale serve` (never `funnel`, so nothing becomes public) and turns it off again with one click. The card notices by itself when you finish a step in a terminal. If Citadel is not allowed to manage Tailscale it shows the one-time `sudo tailscale set --operator=<user>` command, and if Serve is not enabled on your tailnet it links to the page that turns it on. The tailnet address is only advertised in the QR and pairing candidates while the panel is actually being served there. The manual steps are:

1. Install Tailscale on the host and on your phone, signing in to the same account.
2. On the host, proxy the panel onto your tailnet: `tailscale serve https / http://127.0.0.1:3000`.
3. Reload the panel — the QR now points at `https://<host>.<tailnet>.ts.net` and works everywhere, without exposing anything to the public Internet.

Set `CITADEL_PUBLIC_URL` in `.env` to pin any other address (e.g. a named Cloudflare tunnel).

