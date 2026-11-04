# Built-in skills: sources and licenses

SysAiAdm Station's own skills: `linux-common` (rules for working through `remote_exec`: `sudo -n`, no pagers, backup before editing), `proxmox` and `docker` (container and compose diagnostics without `-it`/`-f`, secrets from env are never printed). They are covered by the project license (AGPL-3.0-only).

The rest are taken from open repositories. Each `SKILL.md` keeps its original header with author and license. Full license texts are in [`licenses/`](licenses/).

## peterbamuhigire/linux-skills

MIT, Copyright (c) 2026 Peter Bamuhigire. https://github.com/peterbamuhigire/linux-skills, commit `f904f7bf8ce2e9c0ca12d838d31885af5af76d61`. License: [`licenses/linux-skills.MIT.txt`](licenses/linux-skills.MIT.txt).

`linux-troubleshooting`, `linux-service-management`, `linux-package-management`, `linux-disk-storage`, `linux-log-management`, `linux-network-admin`, `linux-server-hardening`, `linux-virtualization`.

Unmodified. Only `SKILL.md` is included; the original `references/` folders and `sk-*` scripts are not, so relative links in the text lead nowhere: the main text is enough for the agent.

## sickn33/agentic-awesome-skills

Code under MIT (Copyright (c) 2026 Antigravity User), text under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). https://github.com/sickn33/agentic-awesome-skills, commit `753c5f7bb64650b7d3ac0ab84d9b24892d7aed8b`. Licenses: [`licenses/agentic-awesome-skills.MIT.txt`](licenses/agentic-awesome-skills.MIT.txt), [`licenses/agentic-awesome-skills.CONTENT.txt`](licenses/agentic-awesome-skills.CONTENT.txt).

- `windows-server`, `ssh-configuration`, `backup-recovery`, `docker-management`: originally from https://github.com/BagelHole/DevOps-Security-Agent-Skills (MIT, Copyright (c) 2026 Toby Miller, [`licenses/DevOps-Security-Agent-Skills.MIT.txt`](licenses/DevOps-Security-Agent-Skills.MIT.txt)). **Changed:** `windows-server` has an added "Long Operations Over SSH" section (a scheduled task instead of tmux); the other skills are unmodified.
- `powershell-windows`: from the same repository, community section. Unmodified.
