# GremlinOFA Node WebSocket Server

The full backend — agentic loop, storage, encryption, API clients, tools, VFS — running as a standalone Node.js process. Your browser connects over WebSocket and becomes a thin client.

## Build

From the project root:

```bash
npm run build:server
# Output: dist/server/ — self-contained, rsync-able
```

The build produces a ready-to-deploy directory:

```
dist/server/
├── server.js                        # Bundled server (~5MB)
├── package.json                     # Runtime deps (just better-sqlite3)
├── .env.example                     # Configuration template
├── gremlinofa-server.service        # systemd service file (single instance)
├── gremlinofa-server@.service       # systemd template unit (multi-instance)
└── gremlinofa-server.initd          # Alpine Linux OpenRC init
```

## Run

```bash
node dist/server/server.js
```

Or via npm script:

```bash
npm run start:server
```

Options:

```
--instance-env <path>  Load environment from <path> instead of ./.env
-h, --help             Show usage and exit
```

## Configuration

By default the server reads a `.env` file from the working directory if present. Pass `--instance-env <path>` to load a specific file instead — the working-directory `.env` is then ignored, and a missing or unreadable file is a hard startup error (the implicit `.env` stays optional). Either way, explicit environment variables take precedence over env-file values, so systemd `EnvironmentFile` or shell exports always win.

With `--instance-env`, relative `STORAGE_PATH`, `VFS_BASE_PATH`, and `CLAUDE_AGENT_SESSION_DIR` values resolve against the env file's directory instead of the working directory. The env file _is_ the instance: drop a copy of `.env.example` into a directory, point the server at it from anywhere, and the data lands next to it.

Why not `--env-file`? Node claims that flag for itself — current Node even grabs it when it comes _after_ the script path, with its own parsing dialect and its own missing-file error. We picked a name Node won't fight over.

Configuration variables:

| Variable        | Default             | Description                                      |
| --------------- | ------------------- | ------------------------------------------------ |
| `PORT`          | `3100`              | WebSocket listen port                            |
| `HOST`          | `127.0.0.1`         | Bind address                                     |
| `STORAGE_PATH`  | `./data/gremlin.db` | SQLite database file                             |
| `VFS_MODE`      | `filesystem`        | `filesystem` (real files) or `encrypted` (blobs) |
| `VFS_BASE_PATH` | `./data/vfs`        | Base directory for filesystem VFS                |

> **Deploy this for yourself.** Server mode is single-tenant — there's no per-user authz here. With the default `VFS_MODE=filesystem`, your AI's files (and their paths) live **unencrypted** on disk: great for `ls`/`grep`/vim, but readable by anyone with disk access. Run it on hardware you trust, and put TLS + auth in front via a reverse proxy. (`VFS_MODE=encrypted` stores blobs instead if you want the files opaque at rest.)

## Deploy

`dist/server/` is self-contained — rsync it to the target and `npm install` for the native bindings:

### Quick Deploy

```bash
rsync -a dist/server/ you@server:/opt/gremlinofa-server/
ssh you@server 'cd /opt/gremlinofa-server && cp .env.example .env && npm install && node server.js'
```

### systemd (Debian, Ubuntu, RHEL, etc.)

```bash
# Create user
sudo useradd -r -s /bin/false gremlinofa

# Deploy
sudo rsync -a dist/server/ /opt/gremlinofa-server/
sudo chown -R gremlinofa:gremlinofa /opt/gremlinofa-server
cd /opt/gremlinofa-server
sudo -u gremlinofa cp .env.example .env
# Edit .env as needed
sudo -u gremlinofa npm install

# Install and enable service
sudo cp gremlinofa-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gremlinofa-server
sudo systemctl start gremlinofa-server

# Check status
sudo systemctl status gremlinofa-server
sudo journalctl -u gremlinofa-server -f
```

### Alpine Linux (OpenRC)

```bash
# Create user
adduser -S -D -H -h /opt/gremlinofa-server gremlinofa

# Deploy
rsync -a dist/server/ /opt/gremlinofa-server/
chown -R gremlinofa:gremlinofa /opt/gremlinofa-server
cd /opt/gremlinofa-server
su -s /bin/sh gremlinofa -c 'cp .env.example .env'
# Edit .env as needed
su -s /bin/sh gremlinofa -c 'npm install'

# Install init script
cp gremlinofa-server.initd /etc/init.d/gremlinofa-server
chmod +x /etc/init.d/gremlinofa-server
rc-update add gremlinofa-server default
rc-service gremlinofa-server start
```

### Multi-Instance

Same bundle, N gremlins, zero shared state — each instance is just a process with its own env file, data directory, port, and OS user. Deploy the code once to `/opt/gremlinofa-server`, then stamp out instances under `/var/lib/gremlinofa/<name>/`.

**systemd** — use the template unit:

```bash
# Per-instance user + directory
sudo useradd -r -U -s /bin/false gremlinofa-alice
sudo mkdir -p /var/lib/gremlinofa/alice
sudo cp /opt/gremlinofa-server/.env.example /var/lib/gremlinofa/alice/.env
# Edit the .env — a distinct PORT per instance is the one non-negotiable
sudo chown -R gremlinofa-alice:gremlinofa-alice /var/lib/gremlinofa/alice

# Install the template once, then enable per instance
sudo cp /opt/gremlinofa-server/gremlinofa-server@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gremlinofa-server@alice

sudo journalctl -u gremlinofa-server@alice -f
```

Relative paths in the env file resolve against `/var/lib/gremlinofa/alice/`, so the default `STORAGE_PATH=./data/gremlin.db` puts each instance's database in its own directory without editing paths. The template assumes `gremlinofa-<instance>` users; override `User=`/`Group=` with `systemctl edit gremlinofa-server@alice` if you name yours differently.

**OpenRC** — symlink the init script and give the symlink its own conf.d file:

```bash
ln -s gremlinofa-server /etc/init.d/gremlinofa-server.alice
cat > /etc/conf.d/gremlinofa-server.alice <<'EOF'
GREMLINOFA_ENVFILE=/var/lib/gremlinofa/alice/.env
GREMLINOFA_USER=gremlinofa-alice
GREMLINOFA_GROUP=gremlinofa-alice
EOF
rc-update add gremlinofa-server.alice default
rc-service gremlinofa-server.alice start
```

Honest warnings:

- Two instances sharing a `STORAGE_PATH` is on you — there's no lock detection, and SQLite corruption is a lousy way to find out.
- A duplicate `PORT` dies loudly with `EADDRINUSE` at startup and systemd restart-loops it. That's the alarm working, not a bug.
- The claude-agent provider needs each instance's user to have a writable `$HOME` with `claude setup-token` done — and the unit's `ProtectHome=true` blocks home access, same caveat as the single-instance unit.

## Reverse Proxy

The server speaks plain `ws://` — use a reverse proxy for TLS termination. See the main [README.md](../../README.md) for nginx/Apache/Caddy examples.

## License

Apache-2.0 — See [LICENSE](../../LICENSE)
