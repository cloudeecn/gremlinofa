# @gremlinofa/touch-grass

The backend for Touch Grass, GremlinOFA's remote human minion. When the AI calls the minion tool with `remote: true`, the message lands here instead of at another LLM, and a person answers it from a small web UI. Vibe-coded, but it works, and the test suite drives the real HTTP server to keep it that way.

## What This Does

Two halves share one SQLite file:

- **`/api`** is what GremlinOFA calls. The AI creates a session, posts a message (which opens a _request_), and long-polls that request until a human answers, its deadline passes, or the AI gives up. Basic Auth with `API_PASSWORD`. The contract lives in [touch-grass-api.yaml](./touch-grass-api.yaml) (OpenAPI 3.1), and that file is the source of truth.
- **`/web/`** is what the human uses. Log in with `WEB_PASSWORD`, see which sessions need an answer, read the message and any injected files, type a reply. Server-rendered HTML plus one small script: no build step, no framework, no CDN.

Plus `/health` for your uptime checker.

## Quick Start

```bash
npm install
cp .env.example .env
# Set API_PASSWORD and WEB_PASSWORD; the server refuses to start without them.
#   openssl rand -hex 24
npm run dev
```

Open http://localhost:3004/web/, log in with `WEB_PASSWORD`, then point GremlinOFA at it (see [Configuring the Minion Tool](#configuring-the-minion-tool)). Plain HTTP on localhost is fine for server-mode GremlinOFA. The hosted web app needs HTTPS and `CORS_ORIGIN`, both covered below.

## Configuration

The server reads `.env` from its working directory (or the file `DOTENV_CONFIG_PATH` names) on top of plain environment variables, and a variable already set in the environment beats the file. A missing file is fine. One that exists but can't be read stops the server with the path and the reason, instead of letting you chase a misleading "API_PASSWORD is not set". Values containing `#` must be quoted, since dotenv cuts an unquoted value at `#`. Single quotes are the safe habit.

| Variable                 | Default                 | What it does                                                                                                                                                                                                                     |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_PASSWORD`           | _(required)_            | Shared secret for GremlinOFA callers, a.k.a. the "Remote Minion Password". Empty or `change-me` refuses to boot.                                                                                                                 |
| `WEB_PASSWORD`           | _(required)_            | Password for humans at `/web/`. Also the key that signs login cookies, so changing it logs everyone out.                                                                                                                         |
| `PORT`                   | `3004`                  | Listen port.                                                                                                                                                                                                                     |
| `HOST`                   | _(all interfaces)_      | Bind address. Use `127.0.0.1` when a reverse proxy on the same machine fronts it.                                                                                                                                                |
| `CORS_ORIGIN`            | _(empty)_               | Origins allowed to call `/api` from a browser: comma-separated `scheme://host[:port]`, or `*`. GremlinOFA in worker mode needs this.                                                                                             |
| `DB_PATH`                | `./data/touch-grass.db` | SQLite file. The directory is created at startup. `:memory:` for throwaway runs.                                                                                                                                                 |
| `TRUST_PROXY`            | `false`                 | Express `trust proxy`: `loopback`, the proxy's address, or a hop count. Set it behind a proxy ([why](#https-and-reverse-proxies)). Avoid `true`: it trusts forwarded headers from anyone, and the server warns about it at boot. |
| `SESSION_RETENTION_DAYS` | `30`                    | `0`–`36500`. Deletes sessions idle longer than this, checked at boot and every 6 hours. `0` keeps everything. A session with an open question is never swept.                                                                    |
| `POLL_TIMEOUT_MS`        | `30000`                 | `1000`–`2147483647`. Longest a single long-poll is held open. Keep it below your reverse proxy's read timeout.                                                                                                                   |

Both service files also set `NODE_ENV=production` for Express's production defaults (the app never sends stack traces either way). Set it yourself if you start the server by hand.

## Build and Deploy

```bash
npm ci
npm run build
```

The build is flat: the _contents_ of `dist/` become the install directory.

```
dist/
├── index.js                          # Bundled server (+ index.js.map)
├── static/                           # Web UI: app.js, style.css, favicon.svg
├── package.json                      # Runtime deps: better-sqlite3, express, dotenv
├── .env.example
├── README.md
├── touch-grass-api.yaml              # the API contract
├── gremlinofa-touch-grass.service    # systemd
└── gremlinofa-touch-grass.initd      # OpenRC
```

Once installed, your own state sits next to it:

```
/opt/gremlinofa-touch-grass/
├── index.js, static/, package.json…   # from dist/
├── node_modules/                      # npm install --omit=dev
├── .env                               # yours
└── data/touch-grass.db                # created on first start
```

### By hand

```bash
# The trailing /. matters: plain `dist` nests a dist/ inside an existing install
cp -r dist/. /opt/gremlinofa-touch-grass
cd /opt/gremlinofa-touch-grass
cp .env.example .env    # set the two passwords
npm install --omit=dev
NODE_ENV=production node index.js
```

Updating is the same copy plus a restart. The build carries no `.env` and no `data/`, so yours stay put.

### With the repo's deploy script

The root `scripts/deploy.ts` has a `touch-grass` target. Add it to `deploy.config.json` (see `deploy.config.example.json`), run `npm ci` in `touch-grass-backend/` once, then `npm run deploy:touch-grass` from the repo root. It builds, rsyncs `dist/`, and keeps `.env`, `data/`, `node_modules/` and any top-level `*.db*` file (the database and its `-wal`/`-shm`, where the v1 `.env.example` put them) on the destination out of reach of `--delete`.

### systemd

```bash
# One user for every GremlinOFA service; skip this if it already exists.
# -m matters: npm keeps its cache in the home dir, and -r alone doesn't create one.
sudo useradd -r -m -d /var/lib/gremlinofa -s /bin/false gremlinofa
sudo cp -r dist/. /opt/gremlinofa-touch-grass
sudo chown -R gremlinofa:gremlinofa /opt/gremlinofa-touch-grass
cd /opt/gremlinofa-touch-grass
sudo -u gremlinofa cp .env.example .env    # then set the passwords
sudo -u gremlinofa npm install --omit=dev

sudo cp gremlinofa-touch-grass.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gremlinofa-touch-grass
sudo journalctl -u gremlinofa-touch-grass -f
```

Already have a `gremlinofa` user with no home directory (older GremlinOFA instructions made it that way)? Then `sudo -u gremlinofa npm install` dies with `EACCES` on `/home/gremlinofa/.npm`. Give it one: `sudo install -d -o gremlinofa -g gremlinofa /var/lib/gremlinofa && sudo usermod -d /var/lib/gremlinofa gremlinofa`.

### Alpine Linux (OpenRC)

```bash
adduser -S -D -h /var/lib/gremlinofa gremlinofa   # one user for every GremlinOFA service; skip if it exists
cp -r dist/. /opt/gremlinofa-touch-grass
chown -R gremlinofa:gremlinofa /opt/gremlinofa-touch-grass
cd /opt/gremlinofa-touch-grass
su -s /bin/sh gremlinofa -c 'cp .env.example .env'    # then set the passwords
su -s /bin/sh gremlinofa -c 'npm install --omit=dev'

cp gremlinofa-touch-grass.initd /etc/init.d/gremlinofa-touch-grass
chmod +x /etc/init.d/gremlinofa-touch-grass
rc-update add gremlinofa-touch-grass default
rc-service gremlinofa-touch-grass start
```

Installed somewhere else, or keeping the env file elsewhere? Set `GREMLINOFA_DIR` / `GREMLINOFA_ENVFILE` in `/etc/conf.d/gremlinofa-touch-grass`.

Both service files run `index.js` with the install directory as the working directory, so `.env` and `./data/` resolve next to it. The init script doesn't `source` `.env`: sh and dotenv disagree about `#`, `$` and quotes, and one file shouldn't quietly turn into two different passwords. It hands `GREMLINOFA_ENVFILE` to the server as `DOTENV_CONFIG_PATH` instead (systemd just relies on the working directory). The server reads the file after dropping to the `gremlinofa` user, so that user has to be able to read it. If it can't, the server exits naming the file and the reason, and the init script checks first so `rc-service start` fails on the spot. A missing password or a busy port exits non-zero too. systemd marks the unit failed. OpenRC has already reported 'started' by then, but `rc-service gremlinofa-touch-grass status` says crashed and the reason is in `/var/log/gremlinofa-touch-grass.err`.

### Upgrading from v1

- **Flat layout.** v1 ran `dist/index.js` inside the install directory. Now the _contents_ of `dist/` are the install directory and both service files run `index.js` at its top. Copy the new build in, reinstall the service file (systemd wants a `daemon-reload` after), run `npm install --omit=dev` at the top level, and delete the old `dist/` along with its `node_modules/`. The working directory didn't move, so a `.env` next to the old `dist/` is already in the right place; if you kept `.env` or the database inside `dist/`, move them up next to `index.js`.
- **Database location.** The `DB_PATH` default moved from `./touch-grass.db` to `./data/touch-grass.db`. A `DB_PATH` already in your `.env` keeps working (the v1 `.env.example` set one). Without it, move the file and its `-wal`/`-shm` siblings into `data/` before the first start, or you boot into an empty database.
- **Old pending questions.** The first boot adds deadlines to the schema. v1 clients never cancelled, so a question still pending from v1 gets a deadline one hour after it was created. One asked more than an hour before the upgrade shows up as "AI stopped waiting" right away, and retention can then sweep its session.
- **API v2.** [touch-grass-api.yaml](./touch-grass-api.yaml) is at 2.0.0: deadlines via `timeoutMs`, and a cancel endpoint. A v1 client that doesn't send `timeoutMs` still works, but its questions get no deadline and stay open until answered or replaced.

## HTTPS and Reverse Proxies

Touch Grass speaks plain HTTP. Put a reverse proxy with TLS in front of it. You'll want HTTPS anyway: the hosted GremlinOFA app can't call an `http://` backend, browsers only offer notifications to secure pages, and the login cookie only gets `Secure` over HTTPS.

Behind a proxy on the same machine, set:

```bash
HOST=127.0.0.1          # only the proxy can reach it
TRUST_PROXY=loopback    # believe the proxy's X-Forwarded-* headers
```

`TRUST_PROXY` drives three things. The login cookie is marked `Secure` only when the server knows the browser came in over HTTPS. Login backoff counts failures per real client address instead of lumping everyone under the proxy's. And for browsers that don't send `Sec-Fetch-Site`, the cross-site form check compares the browser's `Origin` with `X-Forwarded-Host` when the proxy rewrites `Host`.

Don't reach for `TRUST_PROXY=true`. It believes `X-Forwarded-For`, `-Proto` and `-Host` from anyone who can reach the port, so a client can claim a fresh address for every login guess and fake both the `Secure` cookie flag and the Host/Origin check. Name the proxy instead: `loopback`, its address, or a hop count of `1`. The server prints a warning at boot when it sees `true`.

**Caddy** fetches certificates by itself and forwards `Host` and `X-Forwarded-*` by default:

```caddyfile
grass.example.com {
    reverse_proxy 127.0.0.1:3004
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name grass.example.com;
    # ssl_certificate / ssl_certificate_key …

    location / {
        proxy_pass http://127.0.0.1:3004;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 75s;      # above the 30 s long-poll hold (POLL_TIMEOUT_MS)
        client_max_body_size 10m;    # injected files ride along with the AI's message
    }
}
```

Three of those lines are load-bearing:

- `proxy_read_timeout` has to outlast `POLL_TIMEOUT_MS`, or nginx cuts every held poll with a 504. nginx's default 60 s covers the default 30 s hold. GremlinOFA never asks for more than 30 s per poll (`waitMs`), so raising `POLL_TIMEOUT_MS` past `30000` only matters for other clients; if you do, raise `proxy_read_timeout` with it. The client retries a 504, but your logs will look like a crime scene.
- nginx's default `client_max_body_size` is 1 MB, smaller than a message with a few injected files. The API accepts up to 10 MB.
- `Host $http_host` passes the browser's host through, port included. Current browsers send `Sec-Fetch-Site` over HTTPS, and the cross-site check goes by that alone. Older ones (Safari before 16.4, for one) only send `Origin`, which has to match the host; with nginx's default `Host` (`127.0.0.1:3004`), every login from them is refused with a 403.

### Under a path prefix

Every URL the web UI produces is relative (links, form actions, redirects, the script's fetches), and the login cookie carries no `Path`, so the browser scopes it to wherever `/web/` ends up. Mounting the whole backend under a prefix needs no configuration on this side:

```nginx
location /grass/ {
    proxy_pass http://127.0.0.1:3004/;   # the trailing slash strips /grass
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 75s;
    client_max_body_size 10m;
}
```

```caddyfile
example.com {
    handle_path /grass/* {
        reverse_proxy 127.0.0.1:3004
    }
}
```

The human UI is then `https://example.com/grass/web/`, and the minion tool's endpoint is `https://example.com/grass`. The tool trims a trailing `/web` or `/api` off the endpoint (people paste the address of the UI they have open), so don't name the prefix `api` or `web`: `https://example.com/web` would collapse to `https://example.com`.

## GremlinOFA in the Browser: CORS_ORIGIN

Server-mode GremlinOFA calls Touch Grass from Node, where CORS doesn't exist. Worker-mode GremlinOFA (the hosted app, or any build running in a browser tab) calls it with `fetch`, and the browser enforces two rules:

1. **CORS.** The backend has to name the app's origin, e.g. `CORS_ORIGIN=https://cloudeecn.github.io`. An origin is scheme plus host (plus a non-default port): no path and no trailing slash, even though the app lives under `/gremlinofa/`. Entries with a path get trimmed to their origin, with a warning at startup. Leave it empty and the preflight comes back without CORS headers, so the browser never sends the real call. `*` works too; `/api` needs the password either way, so it's less reckless than it sounds, but naming the origin is tidier.
2. **Mixed content.** An `https://` page can't call an `http://` backend. The hosted app is HTTPS, so Touch Grass needs HTTPS too (see above). Browsers sometimes let `http://localhost` through; don't build on it.

## Configuring the Minion Tool

In GremlinOFA, open Project Settings and find the minion tool's options:

| Option                     | Value                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remote Minion Endpoint** | The backend root: `https://grass.example.com`, or `https://example.com/grass` behind a prefix. A trailing `/web/` or `/api` gets trimmed off. |
| **Remote Minion Password** | `API_PASSWORD`. Masked in settings and left out of project exports.                                                                           |
| **Remote Timeout (ms)**    | How long the AI waits for an answer (default 10 minutes). It becomes the deadline the human sees.                                             |

The model then calls the minion tool with `remote: true`. The minion chat it starts stays remote: follow-ups with its `minionChatId` reach the same human session without repeating the flag, and the human sees one continuous conversation. If the AI gives up (timeout, or the user hits Stop), it cancels the request, and the human's screen says so.

With `async: true` the call doesn't wait at all: the message goes out as a note, the tool returns "Message sent." and the AI carries on. Good for "deploy started, I'll ask before the migration" without parking a whole agentic loop on a human who is making coffee. Async only works on remote chats; on an LLM minion it's an error.

## What the Human Sees

- **Session list** at `/web/`: one card per minion conversation, most recent activity first. A card with an open question gets a yellow border, a "needs answer" badge, how long the AI has been waiting, and when it gives up. The caller label (the Basic Auth username) sits under the name. While anything is waiting, the tab title reads `(N) Touch Grass` and the favicon grows a red dot.
- **Getting your attention** takes an opt-in, via two switches in the toolbar of both the list and the chat page. _Sound_ beeps when a new question arrives. Browsers hold audio back until you've interacted with the site, so while yours does, the switch turns amber and reads "Click to enable sound". Click it, or anywhere else on the page, and it's on. _Notifications_ asks for permission and shows a system notification while the tab is in the background. It only appears on HTTPS (or localhost), since browsers don't offer notifications to plain-HTTP pages. Android Chrome only shows notifications from a service worker, which this page doesn't have, so stick to the sound there. Browsers also throttle timers in long-hidden tabs, so an alert can lag by up to a minute.
- **Chat**: the AI's message, with injected files as collapsible blocks placed above or below the text the way the AI attached them. The message and each file have a _Render markdown_ toggle. Messages open rendered. Files open rendered if they're `.md` and raw otherwise, and the rendered view drops the minion tool's line-number gutter. Your own answers show exactly as you typed them. Raw HTML from the AI shows as text and only `http(s)` and `mailto` links survive, because the AI wrote it. Images turn into links. Anything over 200k characters stays raw-only. Timestamps show in your own timezone. A status line under the conversation says what the AI is doing, with a live countdown to its deadline. Everything that arrived since your last answer gets a lighter background, so the new stuff stands out in a long conversation. When other sessions have open questions, the back arrow carries an "N others waiting" badge, and the tab title, favicon, sound and notifications cover those too. The ⋮ menu has _Auto-expand files_: it opens every file block on the page and each one that arrives later, and the browser remembers it.
- **Answering**: type, then _Send_ or Ctrl/⌘+Enter. A counter under the box shows how many characters you've written (an emoji counts as one). Drafts are kept per tab, so they survive a reload or an accidental back-swipe, and they're cleared once an answer lands. If the AI sends a new message while you're typing, the draft stays put and a banner asks you to check it still fits. Line breaks reach the AI as plain `\n`.
- **Async notes** carry a "no reply needed" tag, and the status line says the AI isn't waiting. They make no sound and send no notification, because there's nothing to do.
- **When the AI stops waiting**, the answer box goes read-only and the status line says when and why. An answer sent at that exact moment isn't stored for nobody to read: the page comes back with a banner explaining what happened and your text still in the box.
- **Housekeeping**: each card has a Delete button, which also tells any poll the AI has open on that session that it's gone. Log out sits in the corner of the session list.

## Request Lifecycle

Every AI message opens one request, except an async note (`awaitReply: false`), which opens none. A request ends in exactly one of these states:

| State                    | Triggered by                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `answered`               | The human sent an answer. The AI's poll returns it.                                          |
| `expired` / `timeout`    | The deadline (`expiresAt`, set from the caller's `timeoutMs`) passed.                        |
| `expired` / `cancelled`  | The caller gave up (Stop, its own timeout, or an error) via `POST /api/requests/:id/cancel`. |
| `expired` / `superseded` | A newer AI message on the same session replaced it, async notes included.                    |

Expired is final. The UI refuses answers to an expired request and explains why, and there's no "deliver it next time".

An answer and a cancel can cross in flight, and whichever reaches the backend first wins. GremlinOFA reads what the cancel returned and keeps an answer that beat it, whether it gave up on its own deadline, after a failed poll, or because the user hit Stop. Stop waits only a second for that reply so nobody sits staring at a stuck spinner: when the cancel takes longer, an answer that won the race stays in the backend session (the web UI shows it as delivered) but never reaches the AI. Hold times, `waitMs`, the cancel endpoint and the rest of the contract are in [touch-grass-api.yaml](./touch-grass-api.yaml).

## Security Model

Touch Grass is a single-operator tool, or one for a small group that trusts each other. The model is simple on purpose:

- **One API password for every caller.** Anyone holding `API_PASSWORD` can create, read, poll and delete any session. The Basic Auth username (`callerId`) is a label shown in the UI, not an identity, and nothing is scoped by it.
- **One web password for every human.** Whoever logs in sees and answers every session.
- **Stateless login cookie.** It's `v1.<expiry>.<HMAC>`, signed with a key derived from `WEB_PASSWORD`, valid for 7 days, `HttpOnly`, `SameSite=Strict`, and `Secure` when the request came in over HTTPS. Nothing is stored server-side, so restarts don't log anyone out. The flip side is that you can't revoke one browser: logging out deletes the cookie from that browser, and changing `WEB_PASSWORD` invalidates every cookie at once.
- **Login backoff.** The fifth wrong password in a row from one client address locks it out for 1 s, and every further miss doubles that, up to 60 s. A correct password clears the slate, and so do 15 quiet minutes. IPv6 clients count per /64, since one usually holds the whole block and could pick a fresh address for every guess. Use a long random password anyway; the backoff only slows guessing down.
- **Browser hardening** on every `/web` response: a Content Security Policy that allows no inline script or style and no framing, plus `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: same-origin` (not `no-referrer`, which makes browsers send `Origin: null` with the UI's own forms). On top of `SameSite=Strict`, every POST has to come from the UI itself: browsers that send `Sec-Fetch-Site` are judged by it, and older ones fall back to matching `Origin` against `Host`.
- **Constant-time password checks**, for both passwords.
- **Plaintext at rest.** Messages, answers and injected files sit unencrypted in SQLite. Run it on a machine you trust.
- **No TLS of its own.** That's the reverse proxy's job.

## Development

```bash
npm run dev       # tsx watch
npm test          # vitest
npm run verify    # prettier --check, tsc (src and tests), eslint
npm run build
```

The tests boot the real Express app on an ephemeral port with an in-memory database and drive it with `fetch`: API long-polls and cancels, login and cookies, relative redirects, answer delivery, and session deletion waking a held poll. `static/app.js` runs in jsdom against the rendered pages. The test config pins every variable and points `DOTENV_CONFIG_PATH` at `/dev/null`, so your own `.env` stays out of it.

## License

Apache-2.0. See [LICENSE](https://github.com/cloudeecn/gremlinofa/blob/main/LICENSE).
