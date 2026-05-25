<p align="center">
  <picture>
    <img src="docs/hero.png" alt="permify-ui — a web UI for Permify" />
  </picture>
</p>

**permify-ui** is a lightweight web UI for [Permify](https://github.com/permify/permify). Browse schema versions, explore relationships, and test access rules from the browser — without exposing the Permify token to the client.

> **Beta.** Compatibility across Permify versions has not been thoroughly tested. This is an independent, community-built project and is not affiliated with or endorsed by Permify or FusionAuth.

## Features

- Browse schema versions and diff against the previous one
- Explore relationships with filters
- Perform access checks: resource check, entity lookup, and subject lookup
- On resource check only, expand the result to see why access was allowed or denied
- Optional OIDC login with an email allowlist

## Requirements

- Go 1.26+
- Node.js 20+ and npm
- A reachable Permify instance

## Getting started

```bash
cp config.example.yaml config.yaml

cd frontend
npm install
npm run build
cd ..

go run .
```

Open [http://localhost:8080](http://localhost:8080). By default the server reads `./config.yaml`; pass an alternative path as the first argument: `go run . /path/to/config.yaml`.

For distribution, build a static binary that embeds the frontend — target hosts need no Node or Go:

```bash
CGO_ENABLED=0 go build -o build/permify-ui .
```

## Configuration

Start from [`config.example.yaml`](config.example.yaml). Main keys:

- `permify_url` — Permify instance URL
- `permify_token` — bearer token used server-side when calling Permify (optional)
- `permify_tenant` — tenant the UI operates on
- `api_access.allowed_endpoints` — whitelist of Permify API calls the server is allowed to proxy
- `auth.enabled` — toggle OIDC login
- `auth.oidc.*` — OIDC provider settings; `redirect_url` must match the external URL users hit (e.g. `https://permify-ui.example.com/auth/callback`)
- `auth.allowed_users` — optional allowlist of user emails

`{tenant}` in `allowed_endpoints` paths is substituted with the value of `permify_tenant`.

## Security model

- The browser talks only to this app, never directly to Permify.
- The server proxies only endpoints listed in `api_access.allowed_endpoints`.
- Browser cookies and client-side auth headers are not forwarded upstream.
- Session cookies have explicit lifetimes and are secured on non-local hosts.
- With OIDC enabled, access can be limited to verified emails on an allowlist.

## License

[MIT](LICENSE).
