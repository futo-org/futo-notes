## Scrolling: fast, or real

`ScrollToRow {"noteId"}` (or `{"path"}` for a folder) brings a row on screen in one call: a
desktop sidebar row, or a row of the phone list you are on. On desktop `ScrollBy
{"x","y","dy"}` moves whatever scrolls under a point by that many pixels. They are
near-instant on desktop (about 70 ms, up to 0.3 s while the window is hidden) and **not input
a person produces**, so `actions` marks them `"convenience": true`. `ScrollToRow` only reaches
what scrolling reaches: a desktop row inside a collapsed folder, or a phone row on another
list, is refused with the batch that opens the way. Use them to get somewhere.
When the behaviour is about **scrolling itself** (wheel handlers, scroll-linked UI, a bug
that needs a real scroll), use the real gesture: `scroll` on desktop (about 0.25 s), `drag`
on a phone.
