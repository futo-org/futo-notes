# Text-first editor host walkthrough

The development editor keeps Markdown meaning in the shared Rust engine and recovery in
Store. Shipping renderers remain unchanged. Use these examples with a future renderer
implementer before relying on the transport. They challenge the adapter contract; passing
native/WASM transport tests does not establish renderer or IME usability. Acceptance and
source/evidence attribution remain in [MR !558](https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/558).

1. **Input while Append is pending.** Type `a`, then `b`, then move the caret while the
   first acknowledgement is withheld. The portable session retains its prepared candidate
   and refuses further input, selection and projection. Which OS callbacks can the adapter
   prevent? Retain each refused payload and the revision its range addresses; serialization
   alone does not rebase ranges. Release accepted text, semantics, selection and affinity
   together, once. A duplicate reply must not insert `a` twice.
2. **Composition while Flush is pending.** Begin marking, start a due flush, then receive
   another marked string. Retain the complete refused update and deliver it once after the
   matching reply. Show how cancellation, a selection echo and repeated composition-end
   preserve the intended text. Withheld completed replies test ordering; they do not model
   blocked filesystem I/O or actual OS composition. A note-id refresh during composition
   changes only wikilink semantics (docs/spec/editor/portable-core/wikilinks.md); the separate
   #294 physical adapter work remains parked.
3. **Coordinate and semantic changes.** Source `__😀__ &amp;` displays `😀 &`. Emoji UTF-16
   `[0,2]` means display bytes `[0,4]`, never source offsets. Reject surrogate splits. A
   replacement addresses the old display; its returned selection addresses the new display.
   Apply the new semantic replacement even if visible bytes are equal. Ordered engine ranges
   carry no anchor/focus direction: show the adapter's direction/history policy. An indexed
   display encoding map may convert coordinates, but contains no Markdown rules.
4. **Copyable failure.** Refuse Append, offer Copy Draft, then resume the same attachment.
   Portable candidate source and accepted display can differ. Native ordinary failure leaves
   the current accepted draft copyable; it does not retain the rejected canonical candidate.
   Retain the rejected raw payload separately and label copied content precisely. A candidate
   source preview would need a Rust capability, never adapter Markdown reconstruction.
   Retry an unaccepted request once; a lost successful reply releases one accepted
   change. Preserve the separate checkpoint-failure policy when recovery logging is healthy.
5. **Worker responsiveness and durability.** Put a 40 ms append or 200 ms flush behind the
   worker. These are scenarios, not measured distributions. Keep the UI thread available,
   retain backpressured input and explain which worker can start a due flush. Native append
   acceptance arms the oldest recovery deadline before engine apply/query; Store locks,
   Rust record conversion and subsequent binding lifting can occupy that interval. Schedule
   using Store's remaining-delay duration, not a cross-platform comparison of raw clocks.

Early optimized ARM32 reconnaissance at `227a69ac7`, with runtime equivalent to reviewed
`4f5fdeb89`/integration `ea38ba288`, completed four shapes on the verified Moto g play 2023.
Four warm samples took 7.22–8.46 ms for separated paragraphs and about 1.1–4.0 seconds for
large single paragraph/list/fence regions. Giant changes returned about 329k text bytes,
329k–349k correspondences and 20k blocks. Immediate paired flush calls took about 8–14 ms;
Rust completion lateness was positive by 0.956–2.310 seconds for giant shapes. The eight-core
device had uncontrolled load around 13–15. These small samples are reconnaissance, not
accepted p95, timer scheduling, OS typing, durability or process-kill proof. Lateness includes
flush storage and excludes pre-accept planning/append; zero hides remaining slack. Deliberate
unflushed warm/jump batches have separate feedback. The reference iPhone remains required
and unavailable.

The existing full paragraph projection has an output-size lower bound. Keep that exported
capability intact; #313/#314 must provide coherent bounded input/results and revision-aware
progressive work on the same engine/Store before renderer reliance. Dropping a duplicate
query alone cannot meet the measured need. Pending work must preserve source ownership,
selection, history, cancellation, stale-result rejection and complete final semantics.
#316 retains final physical latency and healthy-storage 100 ms durability acceptance.

Contract owners: `crates/futo-notes-editor/src/portable.rs`, `session/input.rs`, `session.rs`,
`types.rs`; `crates/futo-notes-store/src/editor_session/recovery.rs`, `facade.rs`;
`crates/futo-notes-ffi/src/editor/mod.rs`, `contract.rs`, `bounded.rs` and
`bounded/contract.rs`. The portable-core specifications
remain the behavioral authority. No coworker has been contacted.

The additive bounded native endpoint owns the same Store page attachment. Enter it
explicitly, obtain its cursor and preparation work, then apply each returned byte
delta together with its complete semantic replacement and generation. Accepted
source copying includes reset/deletion state and a source revision distinct from
recovery watermarks. A refused callback remains the caller's raw payload. Explicit
materialization returns a fresh full native object with the same page history; old
aliases are unavailable. Entry, accepted-source copying, materialization and foreign
binding allocations are proportional operations. This finite contract supplies no
general paragraph/container/table, renderer, IME or physical latency acceptance.
