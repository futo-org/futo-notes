# Stonefruit Cloud — Hosted Architecture

**Status:** DRAFT
**Date:** 2026-03-20
**Context:** Follows from the [Immich Speedrun Strategy](../.context/immich-speedrun-strategy.md). This document covers the hosted version (Month 3+ of that plan).

## Overview

Stonefruit Cloud is a hosted version of the self-hosted sync server. Users who don't want to run their own Docker container get the same experience — sync, overnight AI automations, semantic search — managed by us.

The core principle: **hosted is the same product as self-hosted, we just run the hardware.** No separate codebase, no feature divergence.

## Architecture: Container-Per-User

Instead of rewriting the single-user server into a multi-tenant system, each paying user gets their own isolated container running the existing Stonefruit server image.

```
┌──────────────────────────────────────────────────────────────┐
│  Stonefruit Cloud                                            │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  Control Plane (account mgmt, routing, billing)     │     │
│  │  Polar.sh billing · user/pass auth · recovery keys  │     │
│  └────────┬──────────────────┬──────────────────┬──────┘     │
│           │                  │                  │            │
│  ┌────────▼─────┐  ┌────────▼─────┐  ┌────────▼─────┐      │
│  │ User A       │  │ User B       │  │ User C       │ ...  │
│  │ vault container│  │ vault container│  │ vault container│      │
│  │              │  │              │  │              │      │
│  │ Hono API     │  │ Hono API     │  │ Hono API     │      │
│  │ SQLite       │  │ SQLite       │  │ SQLite       │      │
│  │ Plugins      │  │ Plugins      │  │ Plugins      │      │
│  │ Embeddings   │  │ Embeddings   │  │ Embeddings   │      │
│  │ [encrypted vol]│  │ [encrypted vol]│  │ [encrypted vol]│      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           │                                 │
│                  ┌────────▼────────┐                        │
│                  │  Shared LLM     │                        │
│                  │  Cluster (vLLM) │                        │
│                  │  Qwen 3.5 27B+  │                        │
│                  │  stateless      │                        │
│                  └─────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

### Why container-per-user (container-per-vault)

- **Zero server code changes.** The existing single-user Hono + SQLite server runs unmodified inside each container.
- **Isolation by default.** No risk of cross-tenant data leaks — there's no application-level multi-tenancy to get wrong.
- **GDPR / data deletion is trivial.** Delete user = delete container + volume.
- **Per-user resource limits.** cgroups handle CPU/memory natively.
- **Same as self-hosted.** The hosted container runs the exact same image a self-hoster would run. No feature divergence.
- **Collaboration-ready.** Container-per-vault means shared workspaces are just vault containers with multiple authenticated users. No architectural pivot needed.

### Resource profile

- Idle Hono + SQLite process: ~30-50MB RAM
- Inactive containers can be paused/hibernated, woken on incoming request (cold start latency ~2-5s is acceptable)
- Storage: encrypted volume per vault (size scales with vault)
- **Target: 1,000 real users at launch**
- At 50MB idle per container: ~50GB RAM for 1,000 always-on containers. With hibernation, much less.

### Vault model

- Default: one account = one vault = one container
- Users can create additional vaults (each is a separate container)
- Collaboration: multiple users can be invited to a shared vault container (see Collaboration section)

## Control Plane

A lightweight service that sits in front of vault containers and handles everything that isn't note storage/sync:

- **Account management**: user registration, authentication, recovery keys
- **Routing**: maps incoming client connections to the correct vault container
- **Billing**: Polar.sh integration for subscriptions
- **Provisioning**: spin up / tear down vault containers on signup/deletion
- **Health monitoring**: auto-restart failed containers, hibernate idle ones, rolling image upgrades

### Auth

- **Username/password** for initial launch
- **Recovery key** generated at signup (critical — if user loses password and we can't decrypt their vault, their data is gone)
- **OAuth (Google/GitHub/Apple)**: evaluate later, adds complexity and third-party dependency
- **Borrow from Immich**: the Immich team is building hosted encrypted backups now — reuse their auth patterns and learnings

The control plane authenticates the user and routes them to their vault container. The vault container itself may need minor changes to accept tokens from the control plane instead of (or in addition to) the current single-password flow.

## LLM Service: Shared Cluster

A shared, stateless LLM inference service handles all AI processing. User containers submit jobs; the LLM processes and forgets.

```
[Vault container] → POST /llm/complete → [Job Queue] → [vLLM GPU Worker] → response
```

### Model

- **Current self-hosted**: Qwen 3.5 4B (constrained by user hardware)
- **Cloud**: Qwen 3.5 27B+ (we control the hardware, run the best model we can serve)
- Larger model = better auto-tagging, better daily notes, better plugin quality. This is a real differentiator over self-hosted.
- **Serving**: vLLM for throughput, batching, and multi-GPU support

### GPU Hardware

- **Phase 1**: Rented GPU instances (Lambda, RunPod, or similar)
- **Phase 2**: Interested in building own hardware / data center (longer-term FUTO infrastructure play)
- Sizing: 1,000 users × ~4 plugin runs/night × ~30s inference each = ~33 GPU-hours/night for overnight batch. A single A100 could handle this.

### Privacy model (Proton Lumo-style)

Following Proton's approach with their Lumo AI assistant:

1. **Plugin inside vault container** reads note content from the encrypted volume
2. **Container sends prompt** to shared LLM service (TLS in transit)
3. **LLM processes plaintext** — this is unavoidable; the model must see text to work
4. **LLM responds and forgets** — no logging, no retention, stateless
5. **Container writes result** back to the encrypted volume

**Key constraints on the LLM service:**
- Stateless: no request logging, no conversation history
- No cross-user batching: don't batch prompts from different users in the same inference call (KV cache isolation)
- Sequential per-user: process one user's batch fully before moving to the next
- No disk writes: request payloads never touch persistent storage

### Honest framing

True E2E encryption (where the server never sees plaintext) would require homomorphic encryption on LLM inference, which currently makes a 1-second operation take over a day. Proton faced this same tradeoff and shipped with "User-to-Lumo encryption" — the LLM sees plaintext during processing but retains nothing.

Our privacy guarantee: **Your notes live in an isolated container. Data is encrypted at rest. The LLM sees plaintext only during processing and retains nothing. We cannot access your stored data. If you want zero-trust, self-host.**

## Encryption

### At rest
- Each container's volume is encrypted
- Encryption keys held inside the container, not by the orchestration layer
- Operator (us) cannot read container storage without the user's key

### In transit
- TLS everywhere (client ↔ container, container ↔ LLM service)
- Plugin prompts sent to LLM service over internal TLS

### Recovery keys
- Generated at signup, shown once, user must store securely
- Required if user loses password — without it, encrypted vault is unrecoverable
- This is the same model as Proton Mail, Signal, etc.

### Future: true E2E
- Homomorphic encryption for LLM inference is 2-3 years out for transformer-scale models
- The plugin SDK already abstracts data access behind `sdk.readNoteContent(id)` — when FHE becomes practical, swap the backend without rewriting plugins
- Design for it now, ship without it

## Collaboration

Design for collaboration from day one, even if it ships later.

### Model

Container-per-vault means collaboration is an auth problem, not an architecture problem:

- **Solo vault**: one owner, one container, current behavior
- **Shared vault**: one owner + invited members with roles, same container
- **User in multiple vaults**: client connects to multiple vault containers

### Auth changes needed in the server

The current server has a single password (`WHERE id = 1`). For collaboration:

- Add a `users` table to the vault's SQLite DB (id, role, public_key)
- Roles: `owner`, `editor`, `viewer`
- Owner invites members via the control plane
- Each member authenticates through the control plane, which issues a scoped token for the vault container
- Vault container validates the token and enforces role-based permissions

### What this means now

- The control plane auth token format should support per-vault scoping from the start
- The server's auth middleware should be designed to accept external tokens (not just the single password)
- The `users` table schema can be added to the server now, even if only populated with a single owner initially

## Monetization

| Tier | What you get | Price |
|------|-------------|-------|
| Free | Local-only notes app (no server) | $0 |
| Cloud | Hosted sync + overnight AI automations | Flat rate, $5-10/month |
| Self-hosted | Run your own server (same features as Cloud) | $0 (always free) |

- **Billing via [Polar.sh](https://polar.sh)**
- **Flat rate** preferred over usage-based (simpler to understand, predictable for users)
- **Free trial** available (time-limited, full-featured)
- Self-hosted is never paywalled. Cloud is "we run it for you" + the convenience premium.
- Cloud users get a better LLM (27B vs 4B) as a natural benefit of shared hardware.

## What Needs to Be Built

### 1. Control plane (new service)
- User registration (username/password + recovery key)
- Polar.sh billing integration
- Container provisioning API (create/destroy/hibernate vault containers)
- Request routing (user → vault container)
- Health monitoring, auto-restart, rolling upgrades
- Admin dashboard for ops

### 2. Shared LLM service (new service)
- vLLM serving Qwen 3.5 27B+
- Job queue with per-user rate limiting
- Stateless — no logging, no retention
- Internal API callable only from vault containers

### 3. Container orchestration
- K8s (get help from FUTO/Immich team) or lighter alternative
- Per-container encrypted volumes
- Hibernation/wake-on-request for idle containers
- Image update rollout strategy

### 4. Server changes (minimal)
- Accept external auth tokens from control plane (in addition to single password)
- Add `users` table schema (for future collaboration)
- Health/readiness endpoint for orchestrator
- LLM client that can call shared cluster instead of local Ollama

### 5. Client changes (minimal)
- "Sign up for Stonefruit Cloud" flow alongside manual server URL entry
- Hardcoded cloud endpoint
- Account management UI (plan, billing via Polar.sh portal)
- Multi-vault support in the connection UI (for collaboration)

### 6. Legal / trust
- Privacy policy
- Terms of service
- Security whitepaper (Proton-style, explaining the architecture honestly)

## FUTO Resources

- **Immich team**: building hosted encrypted backups now. Borrow auth patterns, infra knowledge, possibly K8s setup.
- **Hosting/infra**: TBD — could share infrastructure or run independently
- **GPU hardware**: rented initially, potential for owned hardware long-term

## Open Questions

### Resolved
- ~~K8s or simpler?~~ → K8s, get help from FUTO team
- ~~Cold start acceptable?~~ → Yes
- ~~User count target?~~ → 1,000
- ~~GPU hardware?~~ → Rented initially, interested in own data center long-term
- ~~Model size?~~ → Larger than self-hosted (27B+), we control the hardware
- ~~Serving framework?~~ → vLLM
- ~~Auth?~~ → Username/password + recovery key. OAuth later.
- ~~Account layer location?~~ → Separate control plane, outside vault containers
- ~~Vaults per account?~~ → Default one, allow multiple
- ~~Billing?~~ → Polar.sh
- ~~Flat vs usage-based?~~ → Flat rate
- ~~Free trial?~~ → Yes
- ~~Collaboration timeline?~~ → Design for it now
- ~~Immich resources?~~ → Auth patterns + infra knowledge available

### Still Open

1. **Hosting location**: US or EU? EU is a stronger privacy story (like Proton) but depends on where FUTO's infra lives. Need to decide before launch for privacy policy.
2. **Exact pricing**: $5/month? $8/month? $10/month? Obsidian Sync is $4/month (sync only, no AI). Need to find the right number.
3. **Recovery key UX**: How do we ensure users actually save their recovery key? Proton forces you to verify it during signup. Do we do the same?
4. **LLM service auth**: How do vault containers authenticate to the shared LLM cluster? Internal network trust? Per-container API keys? mTLS?
5. **Container image updates**: When we ship a new server version, do containers auto-update? Can users pin a version? What about data migrations?
6. **Hibernation threshold**: How long idle before we pause a container? 1 hour? 24 hours? Does the billing tier affect this?
7. **Storage limits**: Flat rate, but is storage unlimited? A 6,400-note vault is very different from a 50-note vault in storage/compute cost. Cap? Soft limit with upgrade?
8. **Monitoring/alerting**: What observability stack? Need to know when containers are unhealthy, LLM queue is backed up, etc.
9. **Domain/branding**: `cloud.stonefruit.app`? `sync.futo.org`? This affects the hardcoded endpoint in the client.
