## 0. Decisions this plan makes (read before starting)

Justin asked for this plan after a review of the 107 editor commits since the Milkdown merge
(2026-09-21): about a third of them, and three of the open release blockers, are the same
defect class — the native shell and the editor WebView both think they own the open note's
text, and every lifecycle edge (Back, background, rename, sync adopt) has to read across an
async bridge with a deadline and then decide what silence means. This plan removes the read.
The decisions it takes, which the implementing agent must NOT re-litigate or soften:

1. **`BRIDGE_VERSION` goes 8 → 9 (breaking).** The `change` message gains identity, four
   messages are added, two host calls change shape, one host call is replaced. Both native
   hosts move in the same MR (root AGENTS.md M10). This plan is the §11.6 sign-off request;
   Justin reading and approving it is the sign-off.
2. **The shells never evaluate JavaScript to learn what the document says.** Not at exit,
   not at background, not before a reconcile, not for a relink. `getContent` leaves the bridge
   contract. The only reads left are in-process desktop calls on the Svelte component, which
   share a thread with the session and are not the problem.
3. **Every message the editor posts about a document names the document.** `noteId` plus a
   page-monotonic `generation`. A shell routes by id; it never binds "whoever is attached now".
4. **A note switch inside the debounce saves the edit.** Today it drops it unless the shell
   read first (`tests/editor-embed-milkdown.spec.ts:904` pins the drop). That test changes.
5. **"Refuse the exit" survives for exactly one case**: the shell knows the editor holds an
   edit it has not received, asked for it, and did not get it within the deadline. The
   liveness probe, the 60 s "dead after" rule, the three-attempt retry and the
   busy-versus-wedged classification are deleted, because the shell no longer has to infer
   dirtiness from silence — the editor tells it.

What this plan does not do: it does not move serialization to Rust, does not touch sync, does
not change the 200 ms typing debounce, and does not decide whether progressive open stays.
The residual loss window after this work is "typed in the last few hundred milliseconds and
the OS killed the process before any flush ran", which is the window desktop already has.
