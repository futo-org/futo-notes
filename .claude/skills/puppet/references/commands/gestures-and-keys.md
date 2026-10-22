## Gestures, scrolling and keys

**Gestures aim by ref.** `click`/`tap`/`drag`/`scroll` take `{"ref":"e12"}` (or a native
screen's `{"ref":"n4"}`) in place of `x`,`y` and land on that element's centre. A rect's `x,y` is its corner, which is
padding, and a click there reports `no change`. `{"text":"…"}` aims at that text on screen:
in the editor its words, on a phone the one row or words that show it (text two places show
is refused: aim by ref). An argument a gesture does not take is refused, so a misspelt `hold`
is not a short tap. On desktop a `hold`
or a drag's `duration` is at most 3 s, and a `click` or `press` `count` at most 500.

**Scrolling.** On desktop, `scroll {"x","y","dy"[,"dx"]}` is the mouse wheel over that
point: a run of real `wheel` events, `dy` in CSS pixels, positive down. Whatever
scrolls under the point scrolls, and the receipt shows every row that moved. On a
phone, scrolling is a swipe: `drag` from where the finger lands to where it lifts
(up to scroll down). `scroll` there refuses and says so. A real scroll answers in about
0.25 s at any distance on desktop (at most 25 wheel notches; a long scroll spins faster).

**Keys (phones).** `type {"text":"…"}` is real key presses into whatever has focus, through
the OS keyboard: tap the field first (`elements` flags the focused row). It reaches native
fields no verb covers, and in the editor it is the IME path `do Type` skips. The keyboard's
own rules apply as to a person's typing (iOS capitalizes `milk` in search to `Milk`).
`"delay":ms` (1–1000, phones only: desktop refuses it) sends one key at a time, that far
apart, as a person types — for a bug that only shows at human speed; the receipt says the pace it got (`a key every 201 ms`). A key
costs about 130 ms on iOS and 25 ms on Android, so a shorter delay goes that fast instead. Only
US-keyboard characters, and on Android no `%s`, which its input types as a space; a line break
is `press {"key":"Enter"}`. `press` also takes
`Backspace`, `Delete`, `Tab`, `Escape`, `Home`, `End`, `PageUp`, `PageDown` and the arrows
(the editor `Press` verb's names), and `"count":N` sends the key N times as one action.
`press {"key":"Back"}` is **Android's system Back**, not
the app's: it closes the keyboard, the find bar, a dialog or menu before it leaves a screen,
and at the root it leaves the app (`foreground` → false; once the activity is gone `state`
says `screen "none"` and everything else refuses until the app is launched again). The app's
own Back — the top bar's button, and on iOS the edge swipe — is `do GoBack`; iOS has no
system Back and refuses it. A `type` that changed nothing fails: nothing had focus. What
they cannot send (another keyboard's characters, a key they lack) is refused with the
`do Type` or `do Press` call that writes it into the editor.

**Keys (desktop).** `type {"text":"…"}` and `press {"key":"…"}` are the keyboard's own
events, handed to this window's web view (the window is never activated, so the human keeps
focus): the engine runs its key handling and text input, so the browser's own behaviour applies —
`End` scrolls the page on a Mac, `Mod-ArrowRight` goes to the line's end, and an arrow walks a
wrapped line as drawn. Any character types itself (a newline is Return); `press` takes the
editor keymap's chords too (`Mod-b`, `Shift-Tab`, `Mod-Shift-z`; `Mod` is Cmd on macOS, Ctrl elsewhere) and `"count":N`.
Keys go to whatever has focus, so place the caret (or click the field) first. The receipt
prints each key press as one line, its keydown through keyup, and presses that went the same way
share it (`keys "lease" ×5: keydown/beforeinput/input/keyup → e30 … handlers: …`); a press a
handler prevented gets a line of its own, and `events` lists every event.

The instant forms are verbs, **convenience, not real input**: `ScrollBy {"x","y","dy"[,"dx"]}`
moves whatever scrolls under the point by that distance (every screen; 409 when it is
already at its end that way), and `ScrollToRow {"noteId"|"path"}` scrolls the sidebar tree
until that row is on screen (409 with the batch that opens its folders when no scroll could
show it).
Both answer once the page's own `scroll` event has fired (about 70 ms; up to about 0.3 s while
the window is hidden), but send no `wheel`. On the phones `ScrollToRow` is the list screen's
own: it scrolls the list you are on to one of its rows (409 with the batch to the list that
has it), and its receipt is the rows that came and went.
