# Gremlin Of The Friday Afternoon

> Talk to your favourite AI models with just an API Key.
> Local chat history, no phone home.

A vibe coded AI chat client that runs entirely in your browser. Like a famous man once said: "It just works."

## Quick Start

Head to https://cloudeecn.github.io/gremlinofa/ (optionally save to home screen / install PWA) and complete the setup wizard. Then:

1. Click "Configure API" and add an API key for your provider of choice
2. Click "New Project" to create your first project
3. Open the project, tap 🔧, pick a model
4. Start chatting

## Overview

GremlinOFA is a browser-based chat client for multiple AI providers. You bring your own API keys, your data stays on your device (encrypted, no less), and there's no backend server collecting your conversations. It's 95% vibe coded, and just works.

## Features

**Multi-Provider Support**

- Anthropic (attachments, interleaved thinking, web search/fetch/citations)
- OpenAI (both chat completions and responses APIs, with reasoning/web search and attachments)
- Google Gemini (native thinking, Google Search grounding, function calling)
- AWS Bedrock (Converse API plus Claude via Anthropic SDK)
- Any ChatGPT-compatible API (xAI, OpenRouter, local models, whatever). Everyone invented their own reasoning parameter, so pick the dialect per provider — `reasoning_effort`, DeepSeek's `thinking: {type}`, Qwen's `enable_thinking`, or OpenRouter's unified object. The OpenRouter one also feeds signed reasoning blocks back turn over turn, which is what keeps Claude-behind-OpenRouter alive through a tool loop
- Subscriptions instead of API keys: Claude Max via the Claude Agent SDK (server mode), and ChatGPT Plus/Pro via the Codex sign-in — device code or paste-the-redirect-URL, tokens refresh themselves. Costs still show at API-list prices so you can see what you _would_ have paid; flip "Subscription service" in Advanced to track $0 instead. Worker mode needs the CORS proxy for the ChatGPT one. OpenAI tolerates third-party apps on subscription sign-in but doesn't promise it, so keep it personal.

> **Limitation:** I should be direct: Anthropic is on the first-class seat here — it's what the developer uses daily and I wrote all of them, so it gets the most love. Other providers work fine, but if something's janky, that's probably why. PRs to level the playing field are very welcome. -- Claude Opus 4.5

**Organization**

- Project-based chat management with shared settings
- Per-project system prompts, model defaults, temperature, reasoning budget
- Chat forking and message editing

**Rich Rendering**

- Markdown with syntax highlighting (highlight.js, 41 common languages; a fence in something exotic renders plain, and the bundle is ~790 kB lighter for it)
- LaTeX math via KaTeX (`$inline$` and `$$display$$`)
- Collapsible thinking blocks and tool results
- Citations with source links
- Code blocks with copy button
- Prompt-injection-resistant output: model HTML goes through an allowlist, links open in a new tab, and a remote image shows up as a link you choose to open, so nobody gets your secrets via a 1×1 pixel

**Attachments**

- Image support (JPEG, PNG, GIF, WebP)
- Auto-resize and compression; small images go through untouched, so your GIF keeps its animation
- Multi-select, preview
- Stays on-device until you hit send

**Performance**

- Real-time streaming responses, delta-encoded: each update carries only what changed, not the whole reply so far, which is what every chunk used to resend
- Virtual scrolling for 1000+ message histories
- PWA with offline support, plus a "new version is ready" prompt, so a phone that never closes the app still gets updates

**Security**

- All data encrypted locally (AES-256-GCM)
- 52-character encryption key (auto-generated, base32 for easy typing)
- Export/import with re-encryption support
- Single-project export/import (`.gremlin.json` — portable, hand-craftable bundles)

## Getting Started

### Prerequisites

- Node.js 22+ (the OpenAI SDK requires it now; older versions get an `npm install` engine warning and no promises)
- An API key from your provider of choice
- **HTTPS for production** — Web Crypto API and PWA features require a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). `localhost` for development MAY work.

### Installation

```bash
# Clone it
git clone https://github.com/cloudeecn/gremlinofa.git
cd gremlinofa

# Install dependencies
npm install

# Run it
npm run dev
```

Then open `http://localhost:5199`, finish the setup wizard, and let the home page checklist walk you through the rest (API key → project → model).

### Production Build (Browser-Only)

```bash
npm run build
# Output lands in dist/frontend/, serve it however you like
```

### Server Build (Node WebSocket Backend)

```bash
npm run build:server
# Output: dist/server/ — self-contained, rsync-able directory

# Run it
npm run start:server
# Or directly: node dist/server/server.js
```

The server listens on `ws://127.0.0.1:3100` by default. Configure via environment variables:

| Variable        | Default             | Description                                      |
| --------------- | ------------------- | ------------------------------------------------ |
| `PORT`          | `3100`              | WebSocket listen port                            |
| `HOST`          | `127.0.0.1`         | Bind address                                     |
| `STORAGE_PATH`  | `./data/gremlin.db` | SQLite database file                             |
| `VFS_MODE`      | `filesystem`        | `filesystem` (real files) or `encrypted` (blobs) |
| `VFS_BASE_PATH` | `./data/vfs`        | Base directory for filesystem VFS                |

Then open the frontend (either `npm run dev` or a production build), pick "Remote Backend" in the setup wizard, and point it at `ws://your-server:3100` (or `wss://` behind a reverse proxy).

**Multiple instances from one build:** pass `--instance-env` to give each instance its own config:

```bash
node dist/server/server.js --instance-env /var/lib/gremlinofa/alice/.env
```

Relative paths in that file resolve against the file's directory, so each env file fully describes one instance — its port, its data, its user. A `gremlinofa-server@.service` systemd template unit ships in `dist/server/`; see [src/server/README.md](src/server/README.md) for the full recipe.

Note: `better-sqlite3` has native bindings — `npm install` on the target machine before running.

**Reverse proxy for the WebSocket server:**

The server speaks plain `ws://` — put it behind a reverse proxy for TLS termination, same as the other backends.

**nginx**

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

**Apache**

```apache
<Location /ws>
    ProxyPass ws://127.0.0.1:3100
    ProxyPassReverse ws://127.0.0.1:3100
</Location>
```

**Caddy**

```caddyfile
handle /ws {
    reverse_proxy 127.0.0.1:3100
}
```

Point the frontend at `wss://gremlin.example.com/ws` and you're set.

### Deploy Script

Tired of typing rsync incantations? Copy `deploy.config.example.json` to `deploy.config.json` (gitignored, so your hostnames stay yours) and point each target somewhere:

```json
{
  "frontend": { "dest": "you@gremlin.example.com:/var/www/gremlinofa" },
  "server": {
    "dest": "you@gremlin.example.com:/opt/gremlinofa-server",
    "postDeploy": "npm install --omit=dev"
  },
  "vfs-server": { "dest": "/opt/gremlinofa-vfs", "postDeploy": "npm install --omit=dev" },
  "touch-grass": {
    "dest": "you@gremlin.example.com:/opt/gremlinofa-touch-grass",
    "postDeploy": "npm install --omit=dev"
  }
}
```

Then `npm run deploy` (frontend + server, same pair as `npm run build`), or one at a time with `deploy:frontend`, `deploy:server`, `deploy:vfs-server`, `deploy:touch-grass`. Each one builds first, then syncs. Targets missing from the config get skipped. `touch-grass` builds inside its own package, so run `npm ci` in `touch-grass-backend/` once before the first deploy.

- **`dest`** uses rsync syntax: `[user@]host:/path` goes over SSH, anything else is a path on this machine (relative paths resolve against the config file). Custom port or key? Give the host an alias in `~/.ssh/config`.
- **`postDeploy`** runs inside `dest` after the sync. Remote runs go through your login shell, so nvm and friends are on PATH. Chain a `systemctl restart` on the end if you like living fast.
- **`exclude`** / **`rsyncArgs`** add rsync patterns and flags (`.well-known/`, `--chown=…`).
- The sync is `rsync --delete`, but the server targets always protect `.env`, `.env.*` (except `.env.example`, which ships fresh each deploy), `*.env`, `data` (a directory or a symlink to one), `node_modules` and `package-lock.json` on the destination. `touch-grass` also keeps any `*.db*` file at the top level, where its old default put the database. No footguns here, as long as your data lives in `data/`.
- `npm run deploy -- --dry-run` itemizes what would change and only prints `postDeploy`. `--no-build` ships whatever's already in `dist/`, and `--config <file>` picks another config (`deploy.config.*.json` is gitignored too, for staging setups).

Needs Node 22.18+ (the script is TypeScript, run directly by Node), plus `rsync` and `ssh` on your PATH.

### Reverse Proxy Examples

Assuming you've deployed `dist` to `/var/www/gremlinofa/`. Remember: **HTTPS is required** for Web Crypto and PWA features.

**nginx** (with Let's Encrypt via certbot)

```nginx
server {
    listen 443 ssl http2;
    server_name gremlin.example.com;
    root /var/www/gremlinofa;

    ssl_certificate /etc/letsencrypt/live/gremlin.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gremlin.example.com/privkey.pem;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets aggressively
    location ~* \.(js|css|png|ico|svg|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

**Apache** (with Let's Encrypt via certbot)

```apache
<VirtualHost *:443>
    ServerName gremlin.example.com
    DocumentRoot /var/www/gremlinofa

    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/gremlin.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/gremlin.example.com/privkey.pem

    <Directory /var/www/gremlinofa>
        Options -Indexes +FollowSymLinks
        AllowOverride None
        Require all granted

        # SPA routing - serve index.html for all non-file requests
        RewriteEngine On
        RewriteCond %{REQUEST_FILENAME} !-f
        RewriteCond %{REQUEST_FILENAME} !-d
        RewriteRule ^ index.html [L]
    </Directory>

    # Cache static assets
    <LocationMatch "\.(js|css|png|ico|svg|woff2?)$">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </LocationMatch>
</VirtualHost>
```

**Caddy** (auto-provisions HTTPS)

```caddyfile
gremlin.example.com {
    root * /var/www/gremlinofa
    file_server
    try_files {path} /index.html
}
```

### Hosting / Co-hosting Dev Version

Want to run the dev server alongside production on the same domain? The dev build uses `/dev/` as base path and runs on port 5199. The PWA service worker is configured to ignore `/dev/*` requests, so caching won't interfere.

**nginx**

```nginx
# Production at root
location / {
    root /var/www/gremlinofa;
    try_files $uri $uri/ /index.html;
}

# Dev server at /dev (proxy to Vite with HMR support)
location /dev {
    proxy_pass http://127.0.0.1:5199;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

**Apache**

```apache
# Production at root (same as above)
DocumentRoot /var/www/gremlinofa

# Dev server at /dev
<Location /dev>
    ProxyPass http://127.0.0.1:5199/dev
    ProxyPassReverse http://127.0.0.1:5199/dev
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteRule /dev/(.*) ws://127.0.0.1:5199/dev/$1 [P,L]
</Location>
```

**Caddy**

```caddyfile
gremlin.example.com {
    handle /dev/* {
        reverse_proxy 127.0.0.1:5199
    }
    handle {
        root * /var/www/gremlinofa
        file_server
        try_files {path} /index.html
    }
}
```

## Tech Stack

| Layer     | Tech                                                       |
| --------- | ---------------------------------------------------------- |
| Framework | React 19 + Vite                                            |
| Styling   | Tailwind CSS                                               |
| Routing   | React Router v7                                            |
| Storage   | IndexedDB + AES-256-GCM                                    |
| AI SDKs   | @anthropic-ai/sdk, openai, @aws-sdk/client-bedrock-runtime |
| Rendering | marked, highlight.js, KaTeX, DOMPurify                     |
| Testing   | Vitest + Testing Library                                   |

## Security

Your data never leaves your browser. Here's how it works:

1. **Encryption Key (CEK)**: Auto-generated 32-byte key stored in localStorage as base32 (52 characters)
2. **Encryption**: AES-256-GCM encrypts everything in IndexedDB with random IV per operation
3. **Backup**: Copy your key from Manage Data to restore on another device
4. **Export/Import**: Data exports can be decrypted and re-encrypted with different keys

Is it perfect? No. Is it better than sending everything to a server? Definitely.

## Development

See [`development.md`](development.md) for architecture details, data model, and the full feature checklist.

```bash
# Type check, lint, format check
npm run verify

# Run tests
npm run test

# Run tests (minimal output to save your precious context window)
npm run test:silent
```

## Bragging zone / Optional features

### Message Metadata 📊

Want to make your favorite model feel guilty about how much it's costing you? Or maybe just give it a sense of time and space? Message metadata lets the AI know what's happening on your end.

- **Timestamp** — Tell the AI what time it is. Now Opus can nag you to go to sleep at 3 AM instead of just guessing.
- **Context window usage** — Let the AI see how much memory it's using. Sharp models might notice the numbers don't add up and figure out you've been deleting messages.
- **Current cost** — Share the running bill with your AI. Watch it suddenly become very concise.

All optional, configured per-project. Pick your guilt trips wisely.

### Agentic Tools 🔧

Turn your AI into a semi-autonomous agent with client-side tool execution. No server required — everything runs in your browser.

**Memory Tool** — Persistent per-project storage that survives page reloads:

- **`/memories` sandbox** — Each project gets its own memory space, isolated from other projects
- **README auto-injection** — `/memories/README.md` automatically injected into system prompt
- **Full file operations** — Create, view, edit, rename, delete with version history
- **Encrypted at rest** — Same AES-256-GCM as everything else

Implements Anthropic's memory tool spec, so Claude already knows how to use it. Other models figure it out.

**JavaScript Execution** — Run code in a secure QuickJS sandbox:

- **Isolated environment** — Fresh context per call, no DOM access, no network, 300s timeout
- **Filesystem access** — Node-flavored `fs` API over the project's virtual filesystem, including `appendFile` for logs and an array-taking `rm` that deletes a whole batch in one call instead of one round trip per file
- **Library preloading** — Drop UMD/IIFE builds in `/lib` and they load automatically
- **Memories opt-in** — `/memories` stays read-only from JS unless you turn on the tool's own "Writable /memories" option. Bulk-rewriting your agent's memory with a script is now a checkbox away

**Filesystem Tool** — Full VFS access for storing code, data, and artifacts:

- **Text and binary files** — Create images, PDFs, whatever (via dataUrl)
- **Tree operations** — Create, view, edit, rename, delete, recursive directory ops
- **Readonly `/memories`, by default** — The memory tool's space is look-don't-touch for the filesystem tool. Flip its "Writable /memories" option when you want the agent to edit memories with the full toolbox

All tools persist data in the project's encrypted VFS. **Filesystem Manager** lets you peek behind the curtain — read Markdown, SVG and images rendered (sanitized, because the agent wrote them), edit files, step through versions and roll back, ZIP folders in and out, or wipe the slate clean. Every file gets its own URL, so a reload lands right where you were, and the tree works from the keyboard like a civilized file browser.

### Minion Sub-Agents 🤖

Your AI can spawn other AIs. The minion system lets your primary model delegate tasks to sub-agents that run their own agentic loops — with their own tools, their own conversation history, and their own streaming output.

- **Pick a cheaper model** — Delegate research to Haiku while Opus handles the thinking. Your wallet will thank you. With multi-model selection, the orchestrating model picks the right model for each minion at invocation time.
- **Namespace personas** — Give minions persistent identities. Each persona gets its own VFS sandbox (`/minions/<name>`), a custom system prompt (`/minions/<name>.md`), and shared instructions via `/minions/_global.md` (swap that path per-minion with `prePersonaSystemPromptFile`, or pass `''` to opt a minion out). The `/share` directory bypasses namespacing so personas can collaborate on shared artifacts.
- **Minion swarm** — Multiple minions run in parallel within a single turn. The orchestrator fires off a batch, results interleave as they complete, and phased execution ensures simple tools (memory, js) finish before complex ones (minions) start. It's concurrent delegation, not sequential waiting.
- **Scoped tool access** — Minions inherit the project's client-side tools, and the main model can narrow it down per-task. Whether a minion gets the `minion` tool itself is a separate gate (see below).
- **Minions all the way down** — Minions can spawn their own sub-minions: a manager delegating to a team that delegates further. It's off by default and hard-capped (depth 3, configurable) because unbounded recursion is a fantastic way to set money on fire — flip on "Allow Nested Minions" when you actually want it. The sidebar renders the whole loop tree, and you can drill into any sub-minion's chat from its parent's overlay, stack and all. (We used to brag that minions _couldn't_ do this — turns out the footgun just needed a safety.) Live streaming of the deepest level is final-only for now — a nested minion pops in when it finishes; live nested streaming is on the list.
- **Capability delegation, not a free-for-all** — Nesting isn't all-or-nothing once you flip it on. Each call hands the spawned minion a _narrowable_ slice of the orchestrator's own power: `allowNesting` decides per-branch whether that minion may recurse at all, and `availablePersonas` hands it a persona pool it can draw from — which it can only ever narrow further when it delegates onward. So a manager can spawn a researcher that may itself delegate to writers and editors, but never to _other_ managers. Each layer sees only the personas it was granted; over-reach gets a clean rejection, not a silent escape.
- **Conversation control** — The main model decides: start a fresh minion or pick up an existing one. Minion chats persist with their settings (model, persona, tools), so multi-turn delegation just works.
- **Inspect while streaming** — Pop open a minion's full conversation in an overlay without leaving your main chat. Watch sub-agents work in real-time, or collapse and check back later. Drill from a minion into _its_ minion and back out — the overlay stacks.
- **Promote a minion to a real chat** — Hit `⧉` in a minion's overlay and its transcript becomes a chat you drive yourself, still wearing the minion's persona, workspace, tools and model rather than snapping back to the project defaults. The persona and prompt files stay _live_ — edit `/minions/researcher.md` and the next turn picks it up. Useful when a delegated task wandered somewhere interesting and you'd rather take the wheel than keep relaying instructions through the orchestrator. Editing a message that had files injected keeps them, in the mode they were sent with. Each one sits above the composer as a chip, so dropping a file is something you do on purpose.
- **Per-chat agent config** — That override layer isn't clone-only. Any chat's `⋯ → Chat Settings` lets you swap in a persona, point at prompt files, sandbox it to its own VFS namespace, narrow the tool set, or retune the reasoning knobs — each field individually set to inherit from the project or override it, with a preview of the exact prompt the model will receive. Tool choices narrow the project's set; they can't widen it, so the project stays the ceiling.
- **Cost tracking** — Sub-agent costs roll up into your chat totals. No hidden bills.
- **Optional web search** — Gate web access per-project. When enabled, the primary model can grant minions web search on a per-task basis.

**Use cases:** Have Opus dispatch a swarm of Haiku minions to research different angles simultaneously. Set up named personas — a "researcher" for web lookups, an "analyst" for data crunching — each with tailored instructions and their own workspace. Or just enjoy watching LLMs talk to each other — we don't judge.

### DUMMY System ✨

Named after a [certain plug system](https://evangelion.fandom.com/wiki/Dummy_System) that bypasses the pilot when they won't cooperate — except here, the AI _volunteers_ to be overridden.

The DUMMY system (Dynamic Un-inferencing Mock-Message Yielding System) lets LLMs register JavaScript hooks that intercept the agentic loop _before_ each API call — synthesizing responses, handing control back to you, or just letting things pass through.

- **Skip the API call** — Hook returns a synthetic response and the loop continues without burning tokens. Deterministic patterns don't need a round trip to the cloud.
- **Hand control back** — Hook returns `"user"` and the loop stops. The AI decides when it's done, no soft-stop button needed.
- **Passthrough** — Hook returns nothing, API call proceeds normally. Not every iteration needs intervention.
- **Tool calls included** — Synthetic responses can trigger tool calls just like real ones. Your hook can update memory, write files, whatever — then keep going.
- **QuickJS sandbox** — Hooks run isolated with async/await support, VFS read access, and a 120s timeout. No DOM, no network, no footguns.
- **History context** — Configurable sliding window of previous messages, so hooks can make decisions based on conversation flow, not just the last message.
- **Hot-swappable** — Register and unregister hooks mid-conversation. The AI picks its own automation strategy as the task evolves.
- **You can plug one in too** — ⋯ → Attach Hook… picks any `/hooks/*.js` in the chat's namespace; Detach unplugs it. Locked while a reply runs, since the loop already decided who's piloting.

**The pitch:** An agentic loop that calls the API 15 times to do 3 interesting things and 12 obvious ones is wasting your money. DUMMY lets the model front-load the boring decisions into a JS function and only phone home when it actually needs to think.

### Touch Grass (Remote Human Minion) 🌿

Sometimes the best model for the job runs on coffee, not electricity. Touch Grass flips the minion system inside out: instead of delegating to another LLM, your AI delegates to _you_ (or any human with a browser and a password).

- **Same tool, different species.** The LLM calls the minion tool with `remote: true` and the message lands in a small web UI. The tool description tells it a human is on the other end, so it writes a self-contained question instead of assuming the human can read its mind (or its VFS).
- **Sticky by design.** A remote minion chat stays remote. Follow-ups with its `minionChatId` reach the same human conversation without repeating the flag, so a forgetful orchestrator can't quietly hand your approval question to an LLM that answers in your voice.
- **Long-poll with a deadline.** The backend holds each poll for up to 30 seconds and the client keeps polling until the Remote Timeout (default 10 minutes). Blips and backend restarts are retried. When the AI gives up, or you hit Stop, the question is withdrawn and the human's screen says so: no answers typed into the void.
- **Markdown, rendered.** The AI's message arrives rendered, with a toggle back to the raw text. Raw HTML stays text, because the AI wrote it.
- **File context.** Injected VFS files arrive as collapsible blocks, above or below the message the way the AI attached them. The human sees what the AI sees, and the same toggle renders markdown files properly (`.md` opens rendered, line numbers stripped).
- **Fire and forget.** `async: true` sends a note instead of a question: the tool returns "Message sent." at once and the human gets a "no reply needed" tag. Status updates without parking the whole loop on a human.
- **Gets your attention (if you let it).** Opt-in sound and system notifications, a `(N) Touch Grass` tab title, a countdown to the AI's deadline, and drafts that survive a reload or a surprise follow-up question.
- **Self-hosted.** SQLite, Express, systemd or OpenRC, done. No cloud dependency, no third-party accounts.

**Setup** (details in [`touch-grass-backend/README.md`](touch-grass-backend/README.md)):

1. Deploy `touch-grass-backend/` (`npm run deploy:touch-grass` works). Set `API_PASSWORD` and `WEB_PASSWORD` in `.env`; the server refuses to start without them.
2. Using the browser app (worker mode, including the hosted one)? Set `CORS_ORIGIN` to the app's origin (e.g. `https://cloudeecn.github.io`, no path) and put the backend behind HTTPS. An `https://` page can't call an `http://` backend. Server mode talks to it from Node and needs neither.
3. In Project Settings, give the minion tool a **Remote Minion Endpoint** (the backend root, like `https://grass.example.com`), the **Remote Minion Password** (`API_PASSWORD`; masked, and left out of project exports) and, optionally, a **Remote Timeout**.
4. The human opens `https://grass.example.com/web/`, logs in with `WEB_PASSWORD`, and waits for the AI to need help.

**Use cases:** Human-in-the-loop approval for risky actions. Expert consultation mid-task ("hey, should I normalize this column?"). Or just a very elaborate way to text yourself from your AI.

### Remote Storage 🔄

Want to sync across devices without relying on someone else's cloud? There's a self-hostable storage backend for that.

- **SQLite-based** — More reliable than browser storage, still lightweight
- **Per-user namespaces** — Data is keyed by userId (derived from your encryption key). It's separation, not a hardened multi-tenant fortress — Basic Auth ignores the password today, so **deploy this for yourself** (your own devices) or behind a trusted auth layer, not as an open multi-user service.
- **Encrypted at rest** — The backend only ever sees blobs; decryption happens client-side. So even on shared hardware, your conversations stay yours.
- **Easy to deploy** — Single bundled file, systemd/OpenRC service files included

On first launch, the OOBE wizard lets you choose between local (IndexedDB) or remote storage. You can also connect to an existing remote instance with your backup key.

See [`storage-backend/README.md`](storage-backend/README.md) for deployment instructions, API docs, and reverse proxy configurations.

### Remote VFS Backend 📂

Want your AI's memory files on a real filesystem instead of encrypted blobs? The VFS backend stores files on disk — browsable, editable, `grep`-able, all the things encrypted blobs can't do.

- **Real files** — Your AI's files are actual files on a server. `ls` them. `cat` them. Edit them in vim. We won't judge.
- **Per-file locking** — Two writes to different files run in parallel. Server-side, so the frontend doesn't need to think about it.
- **Server-side versioning** — Hidden `.ver/` directories track revision history. Rollback when your AI rewrites that config file for the fifth time. On a copy-on-write filesystem (btrfs, XFS with reflink, bcachefs, OpenZFS 2.2+) each snapshot is a reflink, so a log that gets appended to all day costs blocks for the new lines, not a full copy per append.
- **Compound operations** — `str-replace`, `insert`, `append` are atomic server-side. No TOCTOU races.
- **Plaintext on disk** — The flip side of `grep`-able: files and their paths sit unencrypted on the server. Anyone with disk access can read them, and it's single-tenant by nature, so **deploy this for yourself** on hardware you trust. (Legacy content-only E2E exists but is deprecated — read-only, migration use.)

Configure per-project in Project Settings > Remote VFS. The backend runs standalone — same deployment story as the storage backend.

### Chapter 2: The Frontend/Backend Split — Remote Everything

What started as a single React app got a full-blown architectural glow-up. The entire backend — agentic loop, storage, encryption, API clients, tools, VFS — now lives behind a transport layer with two deployment shapes.

**Web Worker (browser-only)** — The default. The backend runs in a Web Worker while React owns the main thread. You won't even feel a difference despite the full upgrade — except now you can step out to talk to your financial assistant without stopping your role-play character's output. Multiple chats, multiple agentic loops, all running in parallel without freezing your UI.

**Node WebSocket Server (self-hosted)** — The same engine, but running as a standalone Node.js process with SQLite storage and real filesystem VFS. Your browser becomes a thin client over WebSocket. Files on disk are actual files — `ls` them, `grep` them, edit them in vim. And you can finally re-enable your screen lock on your phone — the server keeps working whether your screen is on or not. Same caveat as the VFS backend: `VFS_MODE=filesystem` means real, **unencrypted** files, and it's single-tenant — serve yourself, and put TLS + auth in front via a reverse proxy.

**Auto-reconnect** — WebSocket drops? The transport reconnects with exponential backoff, re-authenticates, and re-attaches all active chat subscriptions. Your session picks up where it left off.

**No more white page of mystery** — The page shows up before the backend does. While it boots you get a checklist: app loaded, backend reached, storage unlocked, projects loaded. If a step hangs or dies, it says which one and why, and after a few seconds it offers a hint and a Reload button. Server down when you open the app? It says so, keeps retrying, and walks in on its own once the server answers. (It used to sit on a white page forever, even after the server came back. Ask us how we know.)

The setup wizard lets you pick your deployment: IndexedDB (local), Remote Storage (sync server), or Remote Backend (full WebSocket server). Pick one, enter a URL if needed, done.

The vibe-coded thing grew a spine, and it's load-bearing.

## License

Apache 2.0 — see [LICENSE](LICENSE)
