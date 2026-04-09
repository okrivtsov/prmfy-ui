# prmfy-ui

prmfy-ui is a lightweight web UI for [Permify](https://github.com/permify/permify).

It helps you inspect schema versions, explore relationships, and run access checks without exposing the Permify token directly to the browser.

> Beta release: this project is still early, and compatibility with different Permify versions has not been thoroughly tested yet.

It combines:

- a Go server for auth, proxying, and serving static assets
- a Vite + React frontend for browsing schemas and testing access rules

## UI Features

- Browse schema versions
- Compare a schema with the previous version
- Explore relationships with filters
- Run permission checks
- Run entity lookup and subject lookup

## Access Control

- Optional OIDC login
- Restrict access with an allowlist of user emails

## Why

Permify is API-first. That is great for integrations, but it is not ideal when you want to inspect schemas, look through relationships, or quickly test access rules by hand.

Without a UI, that workflow usually turns into raw API calls, curl commands, or Postman requests.

prmfy-ui provides a lightweight interface on top of Permify while keeping sensitive configuration on the server side.

## Architecture

- `main.go` runs the HTTP server, handles auth, proxies approved Permify API calls, and serves the built frontend
- `frontend/` contains the Vite + React + Mantine app
- `dist/` contains the production frontend bundle generated from `frontend/`
- `config.example.yaml` shows the expected config shape
- `config.yaml` is the local untracked config file used to run the app

## Requirements

Build-time requirements:

- Go 1.26+
- Node.js 20+ and npm

Runtime requirements:

- A reachable Permify instance
- A `config.yaml` file for the environment where the binary runs

## Screenshots

<p align="center">
  <img src="docs/screenshots/schema-browser.png" alt="Schema browser" width="48%" />
  <img src="docs/screenshots/schema-diff.png" alt="Schema diff" width="48%" />
</p>
<p align="center">
  <img src="docs/screenshots/relationship-explorer.png" alt="Relationship explorer" width="48%" />
  <img src="docs/screenshots/access-check.png" alt="Access check" width="48%" />
</p>

Shown above:

- Schema browser
- Schema diff view
- Relationship explorer
- Access check

## Local Run From Source

Use this flow when you are developing locally from the repository.

1. Create a local config:

```bash
cp config.example.yaml config.yaml
```

2. Update `config.yaml` with your Permify settings.

3. Install frontend dependencies:

```bash
cd frontend
npm install
```

4. Build the frontend bundle:

```bash
cd frontend
npm run build
```

5. Start the server from the repository root:

```bash
go run .
```

6. Open [http://localhost:8080](http://localhost:8080)

The local source-based run expects `config.yaml` in the current working directory unless you pass a different path as the first argument:

```bash
go run . /absolute/path/to/config.yaml
```

## Build A Binary

Use this flow when you want to distribute a standalone binary to another machine.

1. Build the frontend bundle:

```bash
cd frontend
npm ci
npm run build
```

2. Build the Go binary from the repository root:

```bash
mkdir -p build
CGO_ENABLED=0 go build -o build/prmfy-ui .
```

Example cross-compile for Ubuntu 24 on `x86_64`:

```bash
mkdir -p build
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o build/prmfy-ui-linux-amd64 .
```

The resulting binary embeds the contents of `dist/`, so the target machine does not need Node.js, npm, Go, or a separate `dist/` directory.

## Deploy In Company Infrastructure

Use this flow when a colleague receives a prebuilt binary and a config file.

1. Copy the binary and config to the target host.

Example layout:

```text
/usr/local/bin/permify-ui
/usr/local/etc/config-ui.yaml
```

2. Start the binary by passing the config path as the first positional argument:

```bash
/usr/local/bin/permify-ui /usr/local/etc/config-ui.yaml
```

This binary does not support subcommands or flags such as `serve`, `--config`, or `--log-level`.

3. By default the service listens on `:8080`. In practice it is usually placed behind a reverse proxy, load balancer, or ingress and exposed through a company hostname such as `https://permify-ui.company.example`.

4. Make sure `permify_url` points to the Permify instance reachable from that host. Do not leave it as `http://localhost:3476` unless Permify is running on the same machine.

5. If OIDC is enabled, set `auth.oidc.redirect_url` to the external URL used by users, for example:

```yaml
auth:
  enabled: true
  oidc:
    redirect_url: https://permify-ui.company.example/auth/callback
```

6. If OIDC is disabled, restrict network access to the service at the infrastructure layer.

Example `systemd` unit:

```ini
[Unit]
Description=Permify-UI
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/permify-ui /usr/local/etc/config-ui.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Configuration

The application reads settings from a YAML config file. Start from `config.example.yaml` and adjust it for your environment.

Main options:

- `permify_url`: URL of your Permify instance
- `permify_token`: optional bearer token used by the server when talking to Permify
- `permify_tenant`: tenant used by the UI
- `api_access.allowed_endpoints`: required list of Permify API calls the UI is allowed to proxy
- `auth.enabled`: enable or disable OIDC login
- `auth.oidc.*`: OIDC provider settings
- `auth.allowed_users`: optional allowlist of user emails

`api_access.allowed_endpoints` contains items like this:

```yaml
api_access:
  allowed_endpoints:
    - method: POST
      path: /v1/tenants/{tenant}/schemas/list
```

`{tenant}` is replaced with the value of `permify_tenant`.

When launching the app from source with `go run .`, the default config path is `./config.yaml`.

When launching a built binary, pass the config path explicitly:

```bash
./prmfy-ui /path/to/config.yaml
```

## Development

Common commands:

```bash
cd frontend && npm install
cd frontend && npm run build
cd frontend && npm run typecheck
go build ./...
go run .
```

## Security Model

- The browser talks only to this app, not directly to Permify
- The server proxies only API endpoints listed in `api_access.allowed_endpoints`
- Browser cookies and client-side auth headers are not forwarded to Permify
- Session cookies are protected on non-local hosts and have explicit lifetimes
- When OIDC is enabled, access can be limited to verified emails from an allowlist
- `config.yaml` may contain secrets and must stay out of version control

## License

This project is distributed under the prmfy-ui Non-Commercial License 1.0.

- Personal use is allowed
- Internal company use is allowed
- Modification is allowed
- Commercial resale and paid hosted use are not allowed without prior written permission

Commercial licensing requests: okrivtsov@gmail.com

This is a source-available license, not a standard open source license.

## Notes

- This repository does not use Next.js
- Frontend source lives in `frontend/src`
- Production frontend assets are generated into `dist/`
