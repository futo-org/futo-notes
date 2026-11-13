# Text-first editor: adapter walkthrough

Appendix to [the renderer handoff](text-first-editor-host.md). Challenge the adapter contract with these scenarios before relying on the transport. They
are scenarios, not measured distributions.

1. **Input while earlier requests are unanswered.** Type `a`, then `b`, then move the caret
   while the worker's replies are delayed. The page shows each edit at once, issues requests
   1 and 2 and never waits. Which OS callbacks can the adapter run ahead of the worker? None
   matters for correctness: ranges address the page's own revision. Deliver requests in
   sequence order (the desktop client chains `editor_request` calls). A duplicate reply must
   not advance `accepted` twice, and a reply for another session's token changes nothing.
2. **Composition while requests are outstanding.** Begin marking, send a request, then
   receive another marked string. The composition runs against the page's engine with no
   wait. Show how cancellation, a selection echo and repeated composition-end preserve the
   intended text. Delayed replies test ordering; they do not model blocked filesystem I/O
   or actual OS composition. A note-id refresh during composition
   changes only wikilink semantics (docs/spec/editor/portable-core/wikilinks.md); the separate
   #294 physical adapter work remains parked.
3. **Coordinate and semantic changes.** Source `__😀__ &amp;` displays `😀 &amp;` (entities are literal in Linedown). Emoji UTF-16
   `[0,2]` means display bytes `[0,4]`, never source offsets. Reject surrogate splits. A
   replacement addresses the old display; its returned selection addresses the new display.
   Apply the new semantic replacement even if visible bytes are equal. Ordered engine ranges
   carry no anchor/focus direction: show the adapter's direction/history policy. An indexed
   display encoding map may convert coordinates, but contains no Markdown rules.
4. **Copyable failure.** A host error reply pauses the page: input is refused with
   `Paused`, Copy Draft still works from the page's draft, then `resume` the same
   attachment. The reply to `resume` returns the requests the worker lacks; re-send them.
   Native ordinary failure leaves the current draft copyable. Retain a rejected raw payload
   separately and label copied content precisely. Save failures do not pause input; the
   draft stays in memory and saving retries.
5. **Worker responsiveness.** Put a 40 ms replay or 200 ms save behind the worker. These
   are scenarios, not measured distributions. Keep the UI thread available and explain
   which worker can start a due save. Input takes only the attachment lock, so a save in
   progress delays a request's reply, never the page's display. A replayed edit sets the
   save deadlines; schedule using the Store's remaining-delay duration, not a
   cross-platform comparison of raw clocks.
