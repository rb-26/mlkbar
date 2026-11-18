# mlkbar

Self-hosted baby tracker with a web app and an iOS app. Log feeds, pumping, breastfeeds,
naps, nappies, food and growth from any device, with the data on a server you run.

> **Using the iOS app?** You don't need a server. Choose **iCloud** when you set up the app and
> your data stays in your own iCloud account. This guide is only for the **Self-hosted** option
> (which also gives you the web app).

## Features

- Quick-add buttons for feeds, pumping, breastfeeds (with a side timer), naps, poo, wee, food and notes
- Daily log with monthly insights
- Growth page with WHO percentiles for weight, length and head circumference
- Food diary and an allergen introduction checklist
- PDF report and JSON export/import
- Installable web app (PWA) on phones and desktops
- iOS app with widgets, Live Activities and Siri shortcuts, syncing with the same server

## What you need

- A computer that stays on: a NAS (Synology, Unraid, etc.), a home server or a Raspberry Pi
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose

## Install

```bash
git clone https://github.com/rb-26/mlkbar.git
cd mlkbar
mkdir -p data
docker compose up -d --build
```

Open `http://<your-server-ip>:8098` in a browser. **On first visit you choose the password**, so do
this straight away, before you make the server reachable from the internet.

The container runs as user `1000:1000`. If `data/` isn't writable by that user, change `user:` in
`docker-compose.yml` to your own user and group IDs (`id -u` and `id -g`).

## Access away from home

On your home Wi-Fi the LAN address above works. To use mlkbar anywhere you have a few options:

- **Cloudflare Tunnel** (recommended): no open ports on your router. Create a tunnel in the
  [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/), point a hostname such as
  `mlkbar.yourdomain.com` at `http://<your-server-ip>:8098`, then set the proxy options below.
  For extra protection, add a Cloudflare Access policy in front of it.
- **Tailscale**: a private network between your devices. Nothing is exposed to the internet, but
  every phone needs the Tailscale app.
- **Your own reverse proxy** (Caddy, Nginx, Traefik) with HTTPS.

When running behind HTTPS (Cloudflare or a proxy), create a `.env` file next to `docker-compose.yml`:

```bash
LITTLETRACK_SECURE_COOKIE=auto
LITTLETRACK_TRUST_PROXY=true
```

Then run `docker compose up -d` again.

| Setting | Meaning |
|---|---|
| `LITTLETRACK_SECURE_COOKIE=auto` | Secure login cookie on HTTPS, still works on plain HTTP over the LAN. |
| `LITTLETRACK_TRUST_PROXY=true` | Trust `X-Forwarded-*` headers from your proxy. Only enable it behind a proxy. |
| `LITTLETRACK_SECRET_KEY` | Optional. Otherwise a key is generated and kept in `data/`. |

## Connect the iOS app

1. Install mlkbar from the App Store.
2. Choose **Self-hosted**.
3. Enter your server address (e.g. `https://mlkbar.yourdomain.com`, or `http://192.168.x.x:8098` at home) and your password.

Each phone gets its own sign-in token. You can sign out every device from Settings in the web app.

## Install the web app on a phone

Open your server address in Safari (iPhone) or Chrome (Android), then choose **Add to Home Screen**.

## Your data

- Everything is in `data/littletrack.db` (SQLite). Nothing is sent anywhere else.
- Before each database upgrade the app saves a backup in `data/` automatically.
- Back up `data/` regularly. For a safe copy while running:
  `sqlite3 data/littletrack.db ".backup backup.db"`
- You can also export everything as JSON (Settings → Export Data) and import it on another server.

## Updating

```bash
git pull
docker compose up -d --build
```

Database changes are applied automatically on start, after a backup.

## Security notes

- There is one shared password per server. Use a long one.
- Logins are rate-limited: after 5 failures you're locked out for 5 minutes.
- Don't expose port 8098 directly to the internet. Use a tunnel or an HTTPS reverse proxy.

## Troubleshooting

- **Health check:** `curl http://<server>:8098/healthz` should return `{"ok": true}`.
- **Logs:** `docker compose logs -f`
- **Old files after an update:** reload the page. Installed web apps may need closing and reopening.

## Licence

See [LICENSE](LICENSE).
