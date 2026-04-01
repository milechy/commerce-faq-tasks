---
name: deploy-gate
description: Run before any deploy to verify the Test & Deploy Gate sequence is complete.
version: 1.0.0
---

# Deploy Gate Verification

Before deploying, confirm each step is complete in order:

```
1. pnpm verify       → typecheck + lint + test all pass
2. security-scan.sh  → no High/Critical CVEs
3. pnpm build        → clean dist output
4. deploy-vps.sh     → rsync + restart + health check
5. Post-deploy       → curl health endpoint, check PM2 logs
```

## Commands

```bash
# Step 1 — verify
pnpm verify 2>&1 | tail -20

# Step 2 — security scan
bash SCRIPTS/security-scan.sh

# Step 3 — build
pnpm build 2>&1 | tail -10

# Step 4 — deploy (ONLY this command)
bash SCRIPTS/deploy-vps.sh

# Step 5 — post-deploy health check
ssh root@65.108.159.161 'curl -s http://localhost:3100/health && pm2 logs rajiuce-api --lines 10 --nostream'
```

## Rules

- `bash SCRIPTS/deploy-vps.sh` is the ONLY valid deploy command.
- Never use: `ssh ... git pull`, `ssh ... pnpm build`, `ssh ... pm2 restart` as a deploy chain.
- deploy_guard.py PreToolUse hook blocks forbidden patterns automatically.
- Gate must pass fully — no skipping steps, even for "quick fixes".

## Failure handling

| Failure | Action |
|---------|--------|
| typecheck errors | Fix TS errors, re-run pnpm verify |
| lint warnings | Fix warnings, re-run pnpm lint |
| test failures | Fix tests, do not skip |
| High/Critical CVE | Run `pnpm audit --fix` or add pnpm override, re-scan |
| build error | Check tsconfig paths, fix, rebuild |
| PM2 not starting | Check `dist/src/index.js` exists; check `pm2 logs` |
