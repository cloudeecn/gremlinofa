# @gremlinofa/cors-proxy

A small streaming proxy for AI APIs that won't answer a browser's CORS preflight. Vibe-coded, but it works, SSE included.

## What This Does

In worker mode the app talks to providers straight from the browser, and some providers (or their auth endpoints) refuse cross-origin requests. Set an API definition's **CORS Proxy URL** in the app and its requests go here instead. The real destination rides along in an `X-Proxy-Target` header. The proxy forwards the request, streams the response back unbuffered (so token-by-token streaming still streams) and adds the CORS headers the provider forgot.

Server mode talks to providers from Node and doesn't need any of this.

## Quick Start

```bash
npm install
cp .env.example .env   # Edit as needed

# Development (with hot reload)
npm run dev

# Production
npm run build
NODE_ENV=production npm start
```

## Configuration

Everything comes from `.env` in the working directory, the file `DOTENV_CONFIG_PATH` names, or plain environment variables:

| Variable            | Default            | Description                                                                                             |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `PORT`              | `3002`             | Server port                                                                                             |
| `CORS_ORIGIN`       | (empty)            | Origins allowed to call the proxy. Empty = same-domain only, `*` = yolo mode, or a comma-separated list |
| `ALLOWED_TARGETS`   | (empty)            | Comma-separated target domains (subdomains included). Empty = proxy anywhere, fine for dev only         |
| `PROXY_AUTH_TOKEN`  | (empty)            | Shared secret callers must send as `X-Proxy-Auth`. Empty = open proxy                                   |
| `PROXY_TIMEOUT`     | `120000`           | Upstream socket timeout in ms                                                                           |
| `PROXY_BUFFER_SIZE` | `16777216` (16 MB) | Response buffer between upstream and client, so a slow client doesn't stall the upstream. `0` = none    |

Using the hosted app at `https://cloudeecn.github.io/gremlinofa/`? Then `CORS_ORIGIN=https://cloudeecn.github.io`: scheme and host, no path.

An empty `PROXY_AUTH_TOKEN` makes this an open proxy (the startup log warns about it), and with an empty `ALLOWED_TARGETS` on top it's an open relay to the whole internet. Set the token here and the same value as **CORS Proxy Auth Token** on the API definition. It travels in its own header and gets stripped before forwarding, so it never mixes with your provider API key in `Authorization`.

## Reverse Proxy

See [nginx.example.conf](./nginx.example.conf) for serving it under `/cors-proxy/` next to the frontend. The line that matters is `proxy_buffering off`; without it nginx sits on the SSE stream and delivers it in buffer-sized lumps instead of token by token.

## Production Deployment

The build produces a self-contained `dist/` directory. Its _contents_ become the install directory, so `index.js` sits at `/opt/gremlinofa-cors-proxy/index.js` with `.env` right next to it. That flat layout is what the service files expect:

```
dist/
├── index.js                          # Main application bundle
├── index.js.map                      # Source map for debugging
├── package.json                      # Runtime dependencies (express, dotenv)
├── .env.example                      # Configuration template
├── gremlinofa-cors-proxy.service     # systemd service file
└── gremlinofa-cors-proxy.initd       # Alpine Linux OpenRC init
```

The proxy reads `.env` from its working directory itself, so both service files just point the working directory at the install dir. A missing `.env` is fine (defaults and plain environment variables), but one the service user can't read stops the proxy with exit code 1. Otherwise it would start as an open relay with no token and no target list. Don't `source` it from a shell: sh and dotenv disagree about `#`, `$` and quotes, and one file can quietly turn into two different configs. Both service files also set `NODE_ENV=production`, which keeps Express from handing out stack traces in error responses.

### systemd (Debian, Ubuntu, RHEL, etc.)

```bash
# Create user (one for every GremlinOFA service; skip if it exists).
# -m matters: npm keeps its cache in the home dir, and -r alone doesn't create one.
sudo useradd -r -m -d /var/lib/gremlinofa -s /bin/false gremlinofa

# Deploy the contents of dist (the trailing /. matters: plain `dist` nests
# dist/ inside an existing install)
sudo cp -r dist/. /opt/gremlinofa-cors-proxy
sudo chown -R gremlinofa:gremlinofa /opt/gremlinofa-cors-proxy
cd /opt/gremlinofa-cors-proxy
sudo -u gremlinofa cp .env.example .env
# Edit .env: at least ALLOWED_TARGETS and PROXY_AUTH_TOKEN
sudo -u gremlinofa npm install --omit=dev

# Install and enable service
sudo cp gremlinofa-cors-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gremlinofa-cors-proxy

# Check status
sudo journalctl -u gremlinofa-cors-proxy -f
```

Already have a `gremlinofa` user with no home directory (older GremlinOFA instructions made it that way)? Then `sudo -u gremlinofa npm install` dies with `EACCES` on `/home/gremlinofa/.npm`. Give it one: `sudo install -d -o gremlinofa -g gremlinofa /var/lib/gremlinofa && sudo usermod -d /var/lib/gremlinofa gremlinofa`.

### Alpine Linux (OpenRC)

```bash
# Create user
adduser -S -D -H -h /opt/gremlinofa-cors-proxy gremlinofa

# Deploy the contents of dist
cp -r dist/. /opt/gremlinofa-cors-proxy
chown -R gremlinofa:gremlinofa /opt/gremlinofa-cors-proxy
cd /opt/gremlinofa-cors-proxy
su -s /bin/sh gremlinofa -c 'cp .env.example .env'
# Edit .env: at least ALLOWED_TARGETS and PROXY_AUTH_TOKEN
su -s /bin/sh gremlinofa -c 'npm install --omit=dev'

# Install init script
cp gremlinofa-cors-proxy.initd /etc/init.d/gremlinofa-cors-proxy
chmod +x /etc/init.d/gremlinofa-cors-proxy
rc-update add gremlinofa-cors-proxy default
rc-service gremlinofa-cors-proxy start
```

Install somewhere else or keep the env file elsewhere by setting `GREMLINOFA_DIR` / `GREMLINOFA_ENVFILE` in `/etc/conf.d/gremlinofa-cors-proxy`. The env file is handed to the proxy (not sourced by the init script), so it has to be readable by the `gremlinofa` user. When it isn't, the init script names the file and refuses to start before the proxy gets the chance to.

Updating is the same `cp -r dist/. …` plus a restart. The build carries no `.env`, so yours stays put. If the port is already taken the proxy exits with status 1, so systemd's `Restart=on-failure` kicks in instead of treating it as a clean exit.

## License

Apache-2.0
