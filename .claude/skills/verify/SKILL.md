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
| `apps/server/src/routes/dashboard.ts` | dashboard |
| `apps/cli/**` | cli |
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

### If cli:
```bash
cd apps/cli && cargo check 2>&1 | tail -10
```
If there are Rust tests:
```bash
cd apps/cli && cargo test 2>&1 | tail -20
```

### If dashboard:
After server tests pass, do a live smoke test of the dashboard UI. Start the server, then use Playwright MCP (or curl) to exercise the dashboard:

1. Start a temporary server:
```bash
cd apps/server && PORT=3005 NODE_ENV=development npx tsx src/index.ts &
sleep 3 && curl -sf http://localhost:3005/health
```

2. Nuke for clean state, then test the full auth flow:
```bash
# Reset
curl -sf -X POST http://localhost:3005/dev/nuke \
  -H 'Content-Type: application/json' -d '{"confirmation":"DELETE"}'

# Setup
curl -s -X POST http://localhost:3005/setup \
  -H 'Content-Type: application/json' -d '{"password":"testpassword123"}'

# Login
curl -s -X POST http://localhost:3005/login \
  -H 'Content-Type: application/json' -d '{"password":"testpassword123"}'

# Authenticated dashboard status
TOKEN=<from login response>
curl -s http://localhost:3005/dashboard/status \
  -H "Authorization: Bearer $TOKEN"

# Unauthenticated should 401
curl -s -o /dev/null -w '%{http_code}' http://localhost:3005/dashboard/status
```

3. If new API routes were added (e.g. `/change-password`, `/admin/reset-password`), smoke-test each one:
```bash
# Change password
curl -s -X POST http://localhost:3005/change-password \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"current_password":"testpassword123","new_password":"newpassword456"}'

# Admin reset (read token from data dir)
ADMIN_TOKEN=$(tr -d '\n' < apps/server/data/notes/.admin-token)
curl -s -X POST http://localhost:3005/admin/reset-password \
  -H 'Content-Type: application/json' \
  -H "Authorization: AdminToken $ADMIN_TOKEN" \
  -d '{"new_password":"resetpassword789"}'
```

4. Clean up:
```bash
pkill -f "tsx src/index.ts" 2>/dev/null
```

If Playwright MCP browser tools are available, prefer using them to navigate to `http://localhost:3005/` and exercise the UI interactively (fill forms, click buttons, verify state transitions). This catches rendering/JS bugs that curl cannot.

## Step 3: Report

Summarize results in a table:

```
| Check        | Result | Notes              |
|--------------|--------|--------------------|
| TypeScript   | PASS   |                    |
| Build        | PASS   |                    |
| Server tests | PASS   | 239/239 passing    |
| CLI          | PASS   | cargo check clean  |
| Dashboard    | PASS   | auth flow verified |
| Docker       | PASS   | /health OK         |
```

If anything failed, show the relevant error output and suggest a fix.
