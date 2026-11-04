<div align="center">

<img src="apps/web/public/logo.svg" width="96" alt="SysAiAdm Station">

# SysAiAdm Station

**The rise of the machines — on the sysadmin's side.**

Vibe coding was just the warm-up. Meet **vibe-admining** 😎<br>
AI agents maintain and fix your servers over SSH — you watch, approve and drink your coffee.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-0.1.0-orange)
![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)
![React](https://img.shields.io/badge/UI-React%20%2B%20shadcn-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Docker](https://img.shields.io/badge/deploy-docker%20compose-2496ed?logo=docker&logoColor=white)
![Agentless](https://img.shields.io/badge/hosts-agentless%20(SSH%20only)-success)
![Vibe-admining](https://img.shields.io/badge/mode-vibe--admining%20%E2%9C%A8-ff69b4)

<img src="docs/assets/screenshot.png" alt="SysAiAdm Station: server card, agent chat and terminal" width="100%">

</div>

---

## What it is

A web console for sysadmins. One `docker compose up` gives you an infrastructure tree, a chat with an AI agent and a terminal. Agents built on [OpenCode](https://opencode.ai) V2 run commands on your servers **over SSH only**: nothing is installed on the hosts, and the model never sees keys or passwords.

Built for 20–40 hypervisors and 250–300 VMs: Ubuntu, Debian, Proxmox VE, Windows Server (OpenSSH + PowerShell).

> "Why did the disk fill up?", "Which services crashed in the last day?", "Update packages across the whole group" — you write the task, the agent investigates, plans with a rollback and executes. Every command is visible; dangerous ones run only after your "yes".

## Features

| | |
|---|---|
| 🛡️ **Security first** | Keys live in an encrypted vault (AES-256-GCM) inside the sysadm process; the model only gets command output. Command guard: `deny` / read-only / `dangerous`. TOFU host-key pinning on every hop. Login: password + TOTP. Full audit log. |
| 🤖 **Two agents** | **Sysadmin** does the work (recon → plan with rollback → config backup → verification). **Debugger** only reads and finds the root cause with evidence. Any model: cloud or your own llama.cpp / Ollama / vLLM. |
| ✅ **You stay in control** | Read-only commands run immediately, everything else waits: "allow once", "always for this pattern", "deny". Autopilot for 4 hours with the ⚡ button. "Stop" kills the command on the server with SIGKILL. |
| 🌳 **Inventory as a tree** | Companies → groups → hypervisors → VMs. Credentials, user, port, skills and route are inherited from ancestors. Jump hosts up to 3 hops. |
| 📥 **Import in a minute** | RustConn, Remote Desktop Manager, mRemoteNG, Ansible inventory. Passwords are never taken from files. |
| 📇 **Server card** | `/init` collects CPU, memory, disks, filesystems and network with a fixed script — no model, no tokens. |
| ⏳ **Long operations survive disconnects** | The agent runs installs and backups in `tmux` (Linux) or as a one-off scheduled task under SYSTEM (Windows). |
| 🧩 **Plugins** | Terminal, scheduler, WireGuard tunnels, secret masking in output, output compression (RTK). Write your own: [docs/plugins.md](docs/plugins.md). |
| 📚 **Skills** | systemd, disks, logs, networking, hardening, Proxmox, PowerShell… Write your own in the UI or install from GitHub. |
| 🔌 **REST API** | Bearer tokens with scopes and expiry — for scripts, mobile apps and other agents. [docs/api.md](docs/api.md) |
| 🌍 **EN / RU** | Light and dark themes, accent color, fonts. Add your language: [docs/i18n.md](docs/i18n.md). |

## How it works

```
browser ──HTTPS──▶ caddy (:443, the only published port)
                     │
                     ▼
                   sysadm (Bun + Hono): SQLite, encrypted credentials, inventory, SSH
                     │  REST to opencode on 127.0.0.1 (child process of sysadm)
                     ▼
                   opencode serve + sysadm plugin: remote_exec, web_search tools
                     │  POST http://127.0.0.1:3001/internal/* (Bearer, new token on every start)
                     ▼
                   sysadm runs the command over SSH ──▶ [bastion(s)] ──▶ host
```

Invariants:
- Keys and passwords never reach the opencode process or the model context. SSH and decryption happen only in the sysadm process.
- The model does not choose the host or the route. The plugin sends a `sessionID` and a command; the node comes from the task table.
- The agent has no tools besides `remote_exec`, `skill`, `question` and (if enabled) `web_search`. Shell, webfetch, file reads and edits are denied by policy.
- Commands pass the guard: `deny` blocks, `read` (allowlist, `apps/server/src/readonly.ts`) runs without asking, `dangerous` always needs confirmation. The regex check is best-effort, not a guarantee — the final approval is yours.
- Every action is written to the audit log.

## Quick start

```sh
git clone https://github.com/aleks-spv/sysaiadm-station.git && cd sysaiadm-station
cp .env.example .env
echo "SYSADM_MASTER_KEY=$(openssl rand -base64 32)" >> .env   # or set it by hand
docker compose up -d
```

Open `https://localhost`, set the admin password, scan the TOTP code — done.

> [!IMPORTANT]
> **Losing `SYSADM_MASTER_KEY` means losing every credential.** Keep it separate from the `sysadm-data` volume.

> [!NOTE]
> opencode is not baked into the image: on first start the server downloads the latest 2.x from npm into `/data/opencode/bin` (~250 MB, up to a couple of minutes). The container needs access to `registry.npmjs.org`, and to `github.com` for skills from GitHub.

With `SYSADM_TLS=internal` the browser warns about the certificate. Get Caddy's root certificate: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`

## Working with the agent

On a node, click "New task" and describe what you need. The reply streams live: commands (click for the full output in terminal colors), reasoning, skill loading, the plan. Messages can be copied and pinned to the context. When the context passes a threshold (180k tokens by default), the chat suggests starting a new task; older parts of the conversation are compressed by the [DCP](https://www.npmjs.com/package/@tarquinen/opencode-dcp) plugin.

Slash commands: `/health`, `/disk`, `/logs`, `/updates`, `/security`, `/net`, `/service`, plus your own in "Settings → Commands".

Tasks are archived, not deleted (audit); the archive is cleaned up after 90 days.

**Built-in node `SysAiAdm/localhost`** is the station's own container. The agent can inspect the station there and adjust the opencode config through `sysadm-oc` — only as a `dangerous` command with your approval. This node cannot be deleted or moved.

## Models, agents, skills

- **Providers** — keys for cloud providers and your own OpenAI-compatible endpoints (llama.cpp, Ollama, LM Studio, vLLM, gateways). Keys are stored by opencode and never shown again.
- **Models** — hide what you don't need from the lists.
- **Agents** — for Sysadmin and Debugger: model, reasoning level, prompt, color, step limit.
- **opencode config** — extra JSON on top of the base config, plus opencode plugins. `permissions` and `policies` are locked.
- **Skills** — built-in ones come from open MIT-licensed repositories ([skills/NOTICE.md](skills/NOTICE.md)). Enable them per node; they are inherited from the company and group, and OS-specific skills are attached automatically.
- **Web search** — your own SearXNG (needs `search.formats: [html, json]`) or Exa, Tavily, Firecrawl, Parallel, TinyFish. Off by default. Queries containing internal IPs or inventory addresses are rejected; every search is audited.

## Plugins

Enable them in "Settings → Plugins". Each one is a separate package in `plugins/<id>`.

- **Terminal** — an SSH session in the right panel. Copy: select + Ctrl+C or Ctrl+Shift+C; paste: Ctrl+V (clipboard needs HTTPS).
- **Scheduler** — agent tasks on a schedule: once, daily, on weekdays, monthly.
- **WireGuard** — client tunnels to your sites, autostart, status. Needs `NET_ADMIN` and the wireguard kernel module.
- **Secret masking** — passwords, tokens and private keys in output are replaced with `***` before the model sees them. If masking fails, the output is withheld.
- **Token savings (RTK)** — compresses long output and tracks the savings.

## Inventory and connections

Node types: `company`, `group`, `hypervisor`, `vm`. Credentials, user, port and shell are inherited from the nearest ancestor. Assign credentials to a company or group, not to every VM.

**Jump hosts.** Any node can be a bastion. Connection mode: `inherit` (from an ancestor), `direct`, `via` (through a chosen node, up to 3 hops). Each hop uses its own credentials and **its own** pinned host key (TOFU). If a key changes, execution fails and names the hop; reset is manual only ("Reset host key"). Route errors: `JUMP_CYCLE`, `JUMP_TOO_DEEP`, `JUMP_NO_ADDRESS`.

**Import** — preview first, then apply in a single transaction. Re-importing the same file is idempotent.

| Source | How to get the file |
|---|---|
| RustConn | `rustconn-cli export -f native -o inventory.rcn` |
| Remote Desktop Manager | File → Export → Export All (.json) |
| mRemoteNG | `confCons.xml` **unencrypted** (no `FullFileEncryption`) |
| Ansible | `inventory.ini` or `inventory.yml` |

Passwords are never imported from files; key paths only go into node notes. Files up to 5 MB; XML with `<!DOCTYPE`/`<!ENTITY` is rejected.

**Export and migration** — right-click a node → "Export…". The whole tree or a branch goes into a `.sysaiadm` file, always password-encrypted (AES-256-GCM, scrypt, password of 12+ characters). With "Include passwords and keys" the credentials go inside too.

## Operations

<details>
<summary><b>Your own nginx instead of caddy</b></summary>

Remove the `caddy` service from compose and publish port `8080` of the `sysadm` container (preferably on `127.0.0.1`) or attach it to nginx's network. Host folders used instead of volumes must belong to uid 1000: `chown -R 1000:1000 /opt/sysadm`.

```yaml
services:
  sysadm:
    build: { context: ., dockerfile: docker/sysadm.Dockerfile }
    restart: unless-stopped
    env_file: .env
    cap_add: [NET_ADMIN]
    environment:
      DB_PATH: /data/sysadm.sqlite
      INFRA_DIR: /infra
    ports:
      - 127.0.0.1:8080:8080
    volumes:
      - /opt/sysadm/data:/data
      - /opt/sysadm/infra:/infra
      # - /mnt/backup/sysadm:/data/backups   # database backups on another disk
```

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;              # with port: the terminal checks Origin against Host
    proxy_set_header X-Forwarded-For $remote_addr; # not $proxy_add_x_forwarded_for: login rate limit uses it
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;        # WebSocket for the terminal
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;                           # live events (SSE)
    proxy_read_timeout 1h;
    client_max_body_size 6m;                       # file import
}
```

Declare `$connection_upgrade` in `http {}`: `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`. HTTPS only: the session cookie has the Secure flag.
</details>

<details>
<summary><b>Backup and restore</b></summary>

Database backups are automatic: every 24 hours, last 7 kept, in `/data/backups`, via `VACUUM INTO` without stopping the service. Schedule, "Back up now" and downloads are in "Settings → Backups".

Keep separately:
- the database backups (or the whole `sysadm-data` volume);
- `.env` with `SYSADM_MASTER_KEY` — without it a backup is useless;
- the `infra` volume is optional: it is rebuilt from the inventory on start.

Restore: stop the container, put the backup at `/data/sysadm.sqlite`, delete the `-wal` and `-shm` files next to it, start.
</details>

<details>
<summary><b>Updating opencode</b></summary>

Every 6 hours the server checks for a new `@opencode/cli`. When one is out, an "Update" popup appears at the bottom right: download, checksum verification, restart. If the new version doesn't come up within 60 seconds, the previous one is restored. Only 2.x is installed automatically. If `OPENCODE_BIN` is set, updates are disabled.
</details>

<details>
<summary><b>Preparing Windows Server</b></summary>

1. Install OpenSSH Server.
2. Put the public key into `C:\ProgramData\ssh\administrators_authorized_keys`.
3. Make PowerShell the default shell:
   ```powershell
   New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Program Files\PowerShell\7\pwsh.exe" -PropertyType String -Force
   ```
   Without PowerShell 7, use `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`.
</details>

<details>
<summary><b>Environment variables, logs and dev mode</b></summary>

- `SYSADM_DOMAIN`, `SYSADM_TLS` (`internal` — Caddy's self-signed CA), `SYSADM_HTTPS_PORT` — TLS and port.
- `LOG_LEVEL` — `debug` | `info` | `warn` | `error`, default `info`. Logs go to `docker logs` and the "System" page.
- `GITHUB_TOKEN` — optional, for installing skills from GitHub.
- `SYSADM_ENV=dev` — **test stands only**: disables the TOTP check (password, rate limit, guard, encryption, TOFU and CSRF stay on). The login page shows a "DEV mode" banner. Any value other than `dev` or `prod` makes the service refuse to start.

Pre-production checklist: `grep -c '^SYSADM_ENV' .env` → `0`.
</details>

## Development

```sh
bun install
bun run dev
bun test            # 400+ tests
bun run typecheck
bun run build
```

Layout: `apps/server` (Hono API, SQLite, vault, guard, SSH, import), `apps/web` (React + shadcn/ui + Tailwind v4), `packages/shared` (shared types), `packages/plugin` (opencode plugin: `remote_exec`, `web_search`), `plugins/*` (station plugins), `skills/` (built-in skills). Docs: [API](docs/api.md) · [plugins](docs/plugins.md) · [i18n](docs/i18n.md).

Pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Contributors sign the [CLA](CLA.md) once, via a bot comment on the first pull request.

## License

Copyright © 2026 Aleks ([@aleks-spv](https://github.com/aleks-spv)). This is the **Community Edition**, licensed under [GNU AGPL-3.0](LICENSE) (`AGPL-3.0-only`): use, modify and share it freely, but if you let others use a modified version (including over a network), you must publish its source under the same license.

For use without the AGPL terms (closed modifications, embedding in a commercial product), a commercial license is available from the author.

Built-in skills are third-party works under the MIT license; see [skills/NOTICE.md](skills/NOTICE.md).
