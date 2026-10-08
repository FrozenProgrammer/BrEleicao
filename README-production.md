# BR Eleições 2026 — Production v2.9

This package is the direct continuation of Production v2.8.

## What changed

- Added Caddy reverse-proxy configuration (`Caddyfile`) for HTTPS.
- Added a systemd service definition (`br-eleicoes-2026.service`) for automatic restart and a restricted service account.
- The Node application continues to listen on `127.0.0.1:8000` behind the reverse proxy.
- Added a persistent cache location through `BR_ELEICOES_CACHE_DIR`.
- Removed numeric labels from both horizontal graph sets (Top 5 candidates and Top 5 parties).
- Changed both horizontal graph sets to use each item’s share of all valid votes as the bar width, with a 0–100% scale.
- Bound Node.js to `127.0.0.1` by default so the application is not directly Internet-facing.
- Fixed the application version endpoint/health version mismatch.
- Improved reverse-proxy-aware rate limiting, cache writes, upstream timeouts, and atomic downloads/cache files.

## Recommended server layout

Internet → Caddy (HTTPS) → Node.js (127.0.0.1:8000) → persistent cache → TSE

Keep port 8000 private. Only ports 80/443 should be exposed publicly.

## Initial setup (Linux)

1. Install Node.js 20+ and Caddy.
2. Create a dedicated account named `br-eleicoes`.
3. Copy this application to `/opt/br-eleicoes-2026`.
4. Create `/var/lib/br-eleicoes-2026/cache` and give it to `br-eleicoes`.
5. Install the systemd unit as `/etc/systemd/system/br-eleicoes-2026.service`.
6. Replace `example.com` in `Caddyfile` with the real domain and configure Caddy to use it.
7. Start the service and verify `/api/health` locally.
8. Enable both services at boot.

Caddy obtains and renews the public TLS certificate automatically when DNS points the domain to the server and ports 80/443 are reachable.

## Production review checklist

- Run the application as the dedicated `br-eleicoes` user only.
- Keep the Node listener on `127.0.0.1:8000`; expose only Caddy on ports 80/443.
- Keep `/var/lib/br-eleicoes-2026/cache` on persistent storage and monitor free disk space.
- Verify `/api/health` reports `ok: true` after startup.
- Verify `/api/version` reports `2.9.0`.
- Test one presidential and one state-level result query through the public HTTPS URL.
- Test a city/neighborhood selection and confirm the graphs remain percentage-based.
- Confirm Caddy certificate issuance/renewal and automatic service restart after reboot.

## Important before public launch

- Use a persistent disk for `/var/lib/br-eleicoes-2026/cache`.
- Configure DNS and firewall rules before opening the service.
- Keep the Node process inaccessible directly from the Internet.
- Test TSE result requests and the neighborhood index after deployment.
- Keep application logs and monitor disk space because TSE caches can grow over time.
- The site is an independent visualization and should not be presented as the TSE itself.

## v2.9 hardening and optimization

This release keeps the v2.8 UI and data behavior unchanged and focuses on production hardening:

- Deduplicates simultaneous requests for the same uncached TSE result.
- Uses a separate rate limit and concurrency gate for expensive section/section-index work.
- Prevents concurrent downloads of the same large TSE source archive.
- Recovers from corrupted JSON result-cache entries instead of serving a permanent failure.
- Removes stale partial download files and bounds the result-cache by file count and total bytes.
- Adds memory/in-flight-work information to `/api/health`.
- Adds structured Caddy access logging with rotation.
- Adds systemd CPU, memory, task, file-descriptor, and umask limits.
- Keeps Node bound to `127.0.0.1`; only Caddy should be Internet-facing.

### Default production limits

- General API: 120 requests/minute/IP.
- Expensive section endpoints: 12 requests/minute/IP and one active expensive operation at a time.
- Result cache: up to 10,000 files / 2 GiB by default.
- TSE downloads: up to 1 GiB per individual download by default.

All of these can be overridden with environment variables documented by the service file and source. Do not raise them without monitoring memory, disk, and upstream traffic.

### Deployment checklist for a simple domain

1. Use a dedicated Linux user for the application.
2. Point the domain's A/AAAA records to the VPS.
3. Allow only TCP 80/443 at the firewall; keep TCP 8000 private.
4. Install Node.js 20+ and Caddy.
5. Install the systemd service and create `/var/lib/br-eleicoes-2026/cache` owned by `br-eleicoes`.
6. Replace `example.com` in `Caddyfile` with the real domain.
7. Verify Caddy can write its access-log path, or change the path to the host's standard Caddy log directory.
8. Start Node, verify `/api/health` locally, then start Caddy.
9. Test the public HTTPS URL, certificate issuance, result queries, candidate search, Zona/Bairro behavior, and a reboot.
10. Monitor disk, memory, logs, and TSE connectivity before treating the deployment as production-ready.

The cache contains derived TSE data and can be rebuilt. Back up configuration and deployment files separately from the cache; do not treat the cache as the only copy of application configuration.
