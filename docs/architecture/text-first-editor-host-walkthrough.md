# Text-first editor: adapter walkthrough

Appendix to [the renderer handoff](text-first-editor-host.md). Challenge the adapter contract with these scenarios before relying on the transport. They
are scenarios, not measured distributions.

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
