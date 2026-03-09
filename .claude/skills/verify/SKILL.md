---
name: verify
description: Run the appropriate verification chain for recent changes. Detects what changed and runs build, tests, and smoke checks accordingly. Use when the user says "verify", "check this", "does it work", or after completing a feature/fix.
allowed-tools: Bash, Read, Grep, Glob
---

# Verify Skill

Detect what changed and run the right verification chain. Fail fast, report clearly.

## Step 1: Detect what changed

```bash
git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only
git diff --name-only  # unstaged changes too
```

Categorize changed files:

| Pattern | Category |
|---|---|
| `apps/server/**` | server |
| `apps/server/Dockerfile`, `docker-compose*` | server-docker |
| `packages/shared/**` | shared |
| `src/**/*.svelte`, `src/**/*.ts` (not test) | frontend |
| `src/**/*.css` | styles |
| `tests/**` | playwright-tests |
| `.gitlab-ci.yml` | ci |

A change can match multiple categories. Run ALL matching chains.

## Step 2: Run verification chains

Run these sequentially, stopping on first failure:

### Always (unless only CI changed):
```bash
npx tsc --noEmit 2>&1 | head -30
```
If type errors, stop and report.

### If frontend or styles:
```bash
npm run build 2>&1 | tail -20
```

Then run affected Playwright specs:
```bash
npm run test -- <relevant-spec> 2>&1
```

If unsure which spec, run all:
```bash
npm run test 2>&1 | tail -40
```

### If server:
```bash
npm run server:test 2>&1
```

### If server-docker:
After server tests pass:
```bash
cd apps/server && docker compose up --build -d 2>&1 | tail -20
```
Wait for startup, then:
```bash
curl -sf http://localhost:3005/health && echo "OK" || echo "FAIL"
```
Clean up:
```bash
cd apps/server && docker compose down 2>&1
```

### If shared:
```bash
npm run test:shared 2>&1
```

### If unit-testable logic (no UI):
```bash
npm run test:unit 2>&1 | tail -30
```

## Step 3: Report

Summarize results in a table:

```
| Check       | Result | Notes          |
|-------------|--------|----------------|
| TypeScript  | PASS   |                |
| Build       | PASS   |                |
| Server tests| PASS   | 12/12 passing  |
| Docker      | PASS   | /health OK     |
```

If anything failed, show the relevant error output and suggest a fix.
