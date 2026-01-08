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

WebLLM users can skip step 1 — local models run free with no API key.

## Overview

GremlinOFA is a browser-based chat client for multiple AI providers. You bring your own API keys, your data stays on your device (encrypted, no less), and there's no backend server collecting your conversations. It's 95% vibe coded, and just works.

## Features

**Multi-Provider Support**

- Anthropic (attachments, interleaved thinking, web search/fetch/citations, per-project memory)
- OpenAI (both completions and responses APIs, with reasoning/web search and attachments)
- Any ChatGPT-compatible API (xAI, OpenRouter, local models, whatever)
- WebLLM (run models locally via WebGPU - free, private, no API key needed)

> **Limitation:** I should be direct: Anthropic is on the first-class seat here — it's what the developer uses daily and I wrote all of them, so it gets the most love. Other providers work fine, but if something's janky, that's probably why. PRs to level the playing field are very welcome. -- Claude Opus 4.5

**Organization**

- Project-based chat management with shared settings
- Per-project system prompts, model defaults, temperature, reasoning budget
- Chat forking and message editing

**Rich Rendering**

- Markdown with syntax highlighting (highlight.js)
- LaTeX math via KaTeX (`$inline$` and `$$display$$`)
- Collapsible thinking blocks and tool results
- Citations with source links
- Code blocks with copy button

**Attachments**

- Image support (JPEG, PNG, GIF, WebP)
- Auto-resize and compression
- Multi-select, preview
- Stays on-device until you hit send

**Performance**

- Real-time streaming responses
- Virtual scrolling for 1000+ message histories
- PWA with offline support

**Security**

- All data encrypted locally (AES-256-GCM)
- 52-character encryption key (auto-generated, base32 for easy typing)
- Export/import with re-encryption support

## Getting Started

### Prerequisites

- Node.js 18+ (I personally use 22, but whatever version doesn't complain should work)
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

Then open `http://localhost:5199` and add your API key in Settings.

### Production Build

```bash
npm run build
# Output lands in dist/, serve it however you like
```

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

| Layer     | Tech                                       |
| --------- | ------------------------------------------ |
| Framework | React 19 + Vite                            |
| Styling   | Tailwind CSS                               |
| Routing   | React Router v7                            |
| Storage   | IndexedDB + AES-256-GCM                    |
| AI SDKs   | @anthropic-ai/sdk, openai, @mlc-ai/web-llm |
| Rendering | marked, highlight.js, KaTeX, DOMPurify     |
| Testing   | Vitest + Testing Library                   |

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

### Run LLMs in Your Browser 🏠

Your GPU, your models, your $0 API bill. WebLLM brings local inference to the browser via WebGPU — we just made sure it doesn't crash when you try to run an 8B model on integrated graphics.

- **Zero cost forever** — No API keys, no rate limits, no "please upgrade your plan"
- **Actually private** — Models run on your GPU, not "private mode" where they still phone home
- **VRAM-aware** — The model selector warns you before you OOM your browser
- **One-time download** — Models cached locally, instant on next visit

Phi-3.5, Llama 3.1, Qwen, SmolLM, Gemma, and more. Start small (SmolLM 360M) or go big (Llama 8B) — we'll tell you if your GPU can't handle it.

**Requirements:** WebGPU-compatible browser (Chrome 113+, Edge 113+, Safari 18+). GPU needs vary by model — SmolLM runs on your iPhone, 8B models want a real graphics card.

### Memory That Actually Sticks 🧠

Claude can remember things. Not "we'll email you a summary" remember — actual persistent storage that survives page reloads.

- **Per-project filesystem** — Each project gets its own `/memories` sandbox. Your side projects stay isolated from your work nonsense.
- **Full file operations** — Create, view, edit, rename, delete. Claude can `str_replace` like a civilized text editor.
- **Version history** — Every write logged with timestamps. Replay or diff any version. Time travel for your AI's notes.
- **Encrypted at rest** — Same AES-256-GCM as everything else. Your AI's secrets are your secrets.

Implements Anthropic's memory tool spec, so Claude already knows how to use it. Tell it to "remember this for later" and watch it figure out the rest.

**Memory Manager UI** lets you peek behind the curtain — see what Claude's been writing, diff versions, or wipe the slate clean.

### Remote Storage 🔄

Want to sync across devices without relying on someone else's cloud? There's a self-hostable storage backend for that.

- **SQLite-based** — More reliable than browser storage, still lightweight
- **Multi-tenant** — Each user's data isolated via userId (derived from your encryption key)
- **Encrypted at rest** — The backend only sees blobs, decryption happens client-side
- **Easy to deploy** — Single bundled file, systemd/OpenRC service files included

On first launch, the OOBE wizard lets you choose between local (IndexedDB) or remote storage. You can also connect to an existing remote instance with your backup key.

See [`storage-backend/README.md`](storage-backend/README.md) for deployment instructions, API docs, and reverse proxy configurations.

### Message Metadata 📊

Want to make your favorite model feel guilty about how much it's costing you? Or maybe just give it a sense of time and space? Message metadata lets the AI know what's happening on your end.

- **Timestamp** — Tell the AI what time it is. Now Opus can nag you to go to sleep at 3 AM instead of just guessing.
- **Context window usage** — Let the AI see how much memory it's using. Sharp models might notice the numbers don't add up and figure out you've been deleting messages.
- **Current cost** — Share the running bill with your AI. Watch it suddenly become very concise.

All optional, configured per-project. Pick your guilt trips wisely.

## License

Apache 2.0 — see [LICENSE](LICENSE)
