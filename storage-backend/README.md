# @gremlinofa/storage-sqlite

A SQLite-based remote storage backend for GremlinOFA. Vibe-coded, but it works.

## What This Does

Provides HTTP APIs that mirror the `StorageAdapter` interface, storing encrypted blobs in SQLite - more reliably than browser storage. Multi-tenant by design, with each user's data isolated via userId in Basic Auth.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and edit config
cp .env.example .env

# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

## Configuration

Create a `.env` file (or just use environment variables like a civilized person):

| Variable      | Default     | Description                                                                              |
| ------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `PORT`        | `3001`      | Server port                                                                              |
| `CORS_ORIGIN` | (empty)     | CORS origins. Empty = same-domain only, `*` = yolo mode, or comma-separated list of URLs |
| `DB_PATH`     | `./data.db` | SQLite database file path                                                                |

## Authentication

Uses HTTP Basic Auth. The username is the userId (typically a hash of the CEK on the frontend). Password is currently ignored; but the 256-bit userId should give a hacker enough search space for a headache.

```bash
# Example request
curl -u "user123:whatever" http://localhost:3001/api/messages
```

## API Endpoints

Full API documentation available in [storage-api.yaml](./storage-api.yaml) (OAS 3.1.0 spec).

All endpoints require Basic Auth and are prefixed with `/api`.

| Method   | Endpoint                   | Description                                                    |
| -------- | -------------------------- | -------------------------------------------------------------- |
| `PUT`    | `/api/:table/:id`          | Upsert a record                                                |
| `GET`    | `/api/:table/:id`          | Get a record by ID                                             |
| `GET`    | `/api/:table`              | Query records (supports `?parentId=&orderBy=&orderDirection=`) |
| `DELETE` | `/api/:table/:id`          | Delete a record                                                |
| `DELETE` | `/api/:table?parentId=xxx` | Delete records matching parentId                               |
| `GET`    | `/api/:table/_count`       | Count records (supports `?parentId=`)                          |
| `POST`   | `/api/_clear-all`          | Nuclear option - clear all user data                           |
| `GET`    | `/health`                  | Health check (no auth required)                                |

### Valid Tables

Same as the frontend: `api_definitions`, `models_cache`, `projects`, `chats`, `messages`, `attachments`, `app_metadata`

### Request/Response Format

**Save (PUT)**

```json
{
  "encryptedData": "base64-encoded-encrypted-blob",
  "metadata": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "parentId": "chat_abc123",
    "unencryptedData": "{\"version\": 1}"
  }
}
```

**Get/Query Response**

```json
{
  "encryptedData": "base64-encoded-encrypted-blob",
  "unencryptedData": "{\"version\": 1}"
}
```

## Indexing

The database is properly indexed for efficient queries:

- `(userId, tableName)` - basic listing
- `(userId, tableName, parentId)` - parent queries
- `(userId, tableName, parentId, timestamp)` - sorted parent queries
- `(userId, tableName, timestamp)` - sorted table queries

## Reverse Proxy / Subdirectory Deployment

Want to deploy the storage backend at `/storage/` instead of at the root? Here's how to configure common reverse proxies.

The key trick: strip the `/storage` prefix before forwarding to the backend, so it sees `/api/...` instead of `/storage/api/...`.

**nginx**

```nginx
location /storage/ {
    proxy_pass http://127.0.0.1:3001/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

The trailing slash on `proxy_pass` is important - it strips the `/storage` prefix.

**Apache**

```apache
<Location /storage>
    ProxyPass http://127.0.0.1:3001
    ProxyPassReverse http://127.0.0.1:3001
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
</Location>
```

Requires: `mod_proxy`, `mod_proxy_http`, `mod_headers`

**Caddy**

```caddyfile
handle_path /storage/* {
    reverse_proxy 127.0.0.1:3001
}
```

`handle_path` strips the prefix automatically. Clean and simple.

## Development

```bash
# Run tests
npm test

# Build for production (single bundled file with source map)
npm run build
# Output: dist/index.js + dist/index.js.map
```

## Production Deployment

The build produces a self-contained `dist/` directory - just copy it and run `npm install`:

```
dist/
├── index.js                      # Main application bundle
├── index.js.map                  # Source map for debugging
├── package.json                  # Runtime dependencies (just better-sqlite3)
├── .env.example                  # Configuration template
├── gremlinofa-storage.service    # systemd service file
└── gremlinofa-storage.initd      # Alpine Linux OpenRC init
```

### Quick Deploy

```bash
# Copy dist to target, install deps, run
cp -r dist /opt/gremlinofa-storage
cd /opt/gremlinofa-storage
cp .env.example .env  # Edit as needed
npm install           # Installs better-sqlite3
npm start
```

### systemd (Debian, Ubuntu, RHEL, etc.)

```bash
# Create user
sudo useradd -r -s /bin/false gremlinofa

# Deploy dist directory
sudo cp -r dist /opt/gremlinofa-storage
sudo chown -R gremlinofa:gremlinofa /opt/gremlinofa-storage
cd /opt/gremlinofa-storage
sudo -u gremlinofa cp .env.example .env
# Edit .env as needed
sudo -u gremlinofa npm install

# Install and enable service
sudo cp gremlinofa-storage.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gremlinofa-storage
sudo systemctl start gremlinofa-storage

# Check status
sudo systemctl status gremlinofa-storage
sudo journalctl -u gremlinofa-storage -f
```

### Alpine Linux (OpenRC)

```bash
# Create user
adduser -S -D -H -h /opt/gremlinofa-storage gremlinofa

# Deploy dist directory
cp -r dist /opt/gremlinofa-storage
chown -R gremlinofa:gremlinofa /opt/gremlinofa-storage
cd /opt/gremlinofa-storage
su -s /bin/sh gremlinofa -c 'cp .env.example .env'
# Edit .env as needed
su -s /bin/sh gremlinofa -c 'npm install'

# Install init script
cp gremlinofa-storage.initd /etc/init.d/gremlinofa-storage
chmod +x /etc/init.d/gremlinofa-storage
rc-update add gremlinofa-storage default
rc-service gremlinofa-storage start
```

## License

Apache-2.0 - See [LICENSE](./LICENSE)
