# Contributing

Thanks for helping make SysAiAdm Station better!

## Contributor License Agreement

Before your first pull request can be merged, you need to sign the [CLA](CLA.md). The CLA bot posts a comment on your pull request; reply with:

```
I have read the CLA Document and I hereby sign the CLA
```

You sign once; it covers all your future contributions. You keep the copyright in your work. The CLA lets the maintainer offer the project under both the AGPL-3.0 (Community Edition) and commercial licenses.

## Development

```sh
bun install
bun run dev
bun test
bun run typecheck
```

Before opening a pull request:

- `bun test` and `bun run typecheck` pass.
- New `/api` routes are listed in `ROUTE_SCOPES` (`apps/server/src/auth.ts`).
- UI strings go through the i18n dictionaries, Russian and English ([docs/i18n.md](docs/i18n.md)).
- Keys and passwords never reach the opencode process or the model context.
- Third-party code or skills: state the source and license; skills are listed in [skills/NOTICE.md](skills/NOTICE.md).

## Security

Please report vulnerabilities privately via GitHub Security Advisories ("Report a vulnerability" on the Security tab), not in public issues.
