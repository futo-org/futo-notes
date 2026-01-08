# E2EE Sync - Minimal Implementation Plan

## Summary

Build a self-hostable E2EE sync system for FUTO Notes with:
- **Go server** - Simple REST API, filesystem storage, Docker-ready
- **Client encryption** - AES-256-GCM with Argon2 password-derived key
- **Conflict resolution** - Last-write-wins (v1), CRDT planned for v2
- **Metadata** - Filenames visible on server, only content encrypted

---

## Effort Estimate

| Scope | Hours | Timeline |
|-------|-------|----------|
| **Ultra-MVP** (sync works, minimal polish) | ~50h | ~1 week |
| **Full MVP** (error handling, polish) | ~72h | ~1.5 weeks |
| **With tests** | ~98h | ~2.5 weeks |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ React Native Client                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │ crypto   │  │ api      │  │ syncStore│  │ syncEngine  │ │
│  │ (Argon2, │  │ (HTTP    │  │ (MMKV    │  │ (diff,      │ │
│  │  AES-GCM)│  │  client) │  │  state)  │  │  resolve)   │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ HTTPS
┌─────────────────────────────────────────────────────────────┐
│ Go Server (self-hosted)                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ auth     │  │ handlers │  │ storage  │                  │
│  │ (token)  │  │ (REST)   │  │ (files)  │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Client Implementation

### New Files

```
lib/sync/
├── crypto.ts       # Key derivation (Argon2), encrypt/decrypt (AES-256-GCM)
├── api.ts          # HTTP client for sync server
├── syncEngine.ts   # Core sync logic (diff, upload, download, resolve)
├── syncStore.ts    # Zustand store for sync state + MMKV persistence
└── types.ts        # Shared interfaces

app/
└── settings.tsx    # Server URL, password setup UI
```

### Integration Points

| Location | Hook |
|----------|------|
| `app/note/[id].tsx` after `saveNote()` | Queue note for upload |
| `app/index.tsx` after `deleteNote()` | Queue deletion |
| `app/index.tsx` on mount | Trigger sync pull |
| `lib/storage.ts` | Add sync metadata keys |

### Sync Flow

1. Fetch server manifest (`GET /notes` → list of `{id, modifiedAt}`)
2. Diff against local sync metadata in MMKV
3. Resolve conflicts (higher `modifiedAt` wins)
4. Upload local changes (encrypted)
5. Download remote changes (decrypt to filesystem)
6. Update sync metadata

---

## Server Implementation

### API Endpoints

```
POST /api/v1/auth/setup     # Initial password setup → returns token + salt
POST /api/v1/auth/login     # Get token with password

GET  /api/v1/notes          # List all notes {id, modifiedAt}
GET  /api/v1/notes/:id      # Get encrypted note content
PUT  /api/v1/notes/:id      # Upload encrypted note
DELETE /api/v1/notes/:id    # Delete note
```

### Storage (Filesystem)

```
data/
├── config.json             # Hashed auth token, salt
├── notes/
│   └── {note-id}.json      # { content: {iv, ciphertext, tag}, modifiedAt }
└── deleted.json            # Soft-delete tracking for other devices
```

### Self-Hosting

```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /app
COPY . .
RUN go build -o server ./cmd/server

FROM alpine
COPY --from=build /app/server /usr/local/bin/
EXPOSE 8080
VOLUME /data
CMD ["server", "-data", "/data"]
```

---

## Work Breakdown (Ultra-MVP)

### Phase 1: Server Foundation (~16h)
- [ ] Go project setup, folder structure
- [ ] REST handlers (notes CRUD)
- [ ] Auth middleware (bearer token)
- [ ] Filesystem storage layer

### Phase 2: Client Crypto (~8h)
- [ ] Argon2 key derivation (via expo-crypto or native module)
- [ ] AES-256-GCM encrypt/decrypt
- [ ] Key storage in MMKV

### Phase 3: Client Sync Engine (~16h)
- [ ] HTTP API client
- [ ] Sync metadata store (MMKV)
- [ ] Diff algorithm (local vs server)
- [ ] Last-write-wins conflict resolution
- [ ] Upload/download orchestration

### Phase 4: Integration (~6h)
- [ ] Hook save → queue upload
- [ ] Hook delete → queue deletion
- [ ] Hook app start → sync pull

### Phase 5: Settings UI (~4h)
- [ ] Settings screen (server URL, password)
- [ ] Password entry + key derivation flow
- [ ] Sync status indicator

---

## Simplifications for MVP

| Cut | Impact |
|-----|--------|
| Skip checksums | No corruption detection (add later) |
| Skip retry logic | User manually retries on failure |
| Skip incremental changes endpoint | Full manifest fetch each sync |
| Skip clock skew detection | Assume device clocks are correct |

---

## Critical Files to Modify

- `lib/storage.ts` - Add sync-related MMKV keys
- `lib/notesLoader.ts` - Add post-load sync hook
- `app/note/[id].tsx` - Add post-save sync trigger
- `app/index.tsx` - Add delete sync + startup sync
- `app/_layout.tsx` - Add settings route

---

## Verification

1. **Server**: Run locally, test endpoints with curl
2. **Client crypto**: Unit test encrypt→decrypt roundtrip
3. **End-to-end**:
   - Create note on device A → syncs to server
   - Device B pulls → note appears
   - Edit on B → syncs back
   - Device A pulls → sees edit
4. **Conflict**: Edit same note offline on A and B, reconnect, verify LWW behavior

---

## Future (v2)

- CRDT/Yjs for seamless merge (no conflicts)
- Selective sync (local-only notes)
- Multi-user sharing
- Encrypted filenames option
