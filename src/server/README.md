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
├── gremlinofa-server.service        # systemd service file
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

## Configuration

The server reads a `.env` file from the working directory if present. Explicit environment variables take precedence over `.env` values, so systemd `EnvironmentFile` or shell exports always win.

Configuration variables:

| Variable        | Default             | Description                                      |
| --------------- | ------------------- | ------------------------------------------------ |
| `PORT`          | `3100`              | WebSocket listen port                            |
| `HOST`          | `127.0.0.1`         | Bind address                                     |
| `STORAGE_PATH`  | `./data/gremlin.db` | SQLite database file                             |
| `VFS_MODE`      | `filesystem`        | `filesystem` (real files) or `encrypted` (blobs) |
| `VFS_BASE_PATH` | `./data/vfs`        | Base directory for filesystem VFS                |

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

## Reverse Proxy

The server speaks plain `ws://` — use a reverse proxy for TLS termination. See the main [README.md](../../README.md) for nginx/Apache/Caddy examples.

## License

Apache-2.0 — See [LICENSE](../../LICENSE)
