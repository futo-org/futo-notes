---
name: V1 sync protocol being dropped
description: User is dropping V1 sync format (all_uuids). Only V2 (inventory-based) sync going forward.
type: project
---

V1 sync format (using `all_uuids` field) is being deprecated. Only V2 sync (using `inventory` array) will be supported going forward.

**Why:** Simplification — no need to maintain two code paths for the sync protocol.

**How to apply:** Don't write tests for V1 sync format. Don't add V1 compatibility. SyncClient helpers should use V2 (inventory) payloads exclusively. When touching sync code, it's OK to remove V1 handling.
