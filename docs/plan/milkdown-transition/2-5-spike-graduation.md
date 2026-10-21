## 2.5 Spike graduation (how D3 is executed)

The spike branch is the **starting point, not a blessed merge**: it graduates through review, and a
clean rewrite is explicitly rejected (it would re-earn a working two-shell integration to reach the
same code). Known debts the review pays down:

- `MilkdownEditor.svelte` (1,152 lines) and `mobileBlockDnd.ts` (721 lines) need a real review
  pass (`/slow-review` grade) and likely decomposition before merge.
- `formatState`/`haptic` are iOS-only: add the Android consumers or record the asymmetry as an
  explicit spec gap — the spike's "no consumer yet" exemption is not a shippable end state.
  **Both paid: `formatState` in #104, `haptic` on 2026-09-01 when Android took the long-press block
  drag (§4) and gained `performBlockDragHaptic`.**
- The spike's parked string guards are replaced by §3's plugin set, not resumed.
- **Done.** The `?cm` escape switch and the `spike-notes/` directory are gone; their content
  graduated into this plan, spec lines, `docs/editor/milkdown-roundtrip-census.md`, and test
  fixtures.
- Rebase onto main and rename to a `feat/` branch when execution starts.

- [T1 outcome (#98, done)](2-5-spike-graduation/t1-outcome.md)
- [T7 outcome (#104, done)](2-5-spike-graduation/t7-outcome.md)
- [T3 outcome (#100, done)](2-5-spike-graduation/t3-outcome.md)
- [T4 outcome (#101, done)](2-5-spike-graduation/t4-outcome.md)
- [T5 outcome (#102, done)](2-5-spike-graduation/t5-outcome.md)
