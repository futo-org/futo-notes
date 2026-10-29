# Shared Rust editor core: implementation tickets

Approved and published 2026-10-29 under [the engine/store spec](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/283).
All 34 tickets are native Task children of #283 and carry `ready-for-agent`; execution must
still respect their blockers. Conversion retained their issue numbers, content and labels. The initial
frontier is [Edit, save and recover a plain note](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/284).

The GitLab license rejects native blocking links. Each issue therefore records its blockers
explicitly in its description, following the configured tracker fallback. The 53 dependency
edges, all issue bodies/labels and the absence of cycles were verified after publication.
The parent specification, labels and state were left unchanged. Its hierarchy was verified
to contain exactly the 34 Task children below. Child hierarchy is available independently
of the licensed blocking-link feature.

This phase produces the shared Rust editor engine, coordinated store recovery, thin
Swift/Kotlin/WebAssembly consumers and the portable host contract. After core acceptance,
a coworker takes desktop while the maintainer builds Android/iPhone. Full platform renderers
and the large Bootcamp campaigns are later work. Each feature ticket includes its own tests.

| Plan order | Ticket | Blocked by |
| --- | --- | --- |
| 1 | [#284 - Edit, save and recover a plain note](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/284) | None |
| 2 | [#285 - Protect edits when storage fails or power is lost](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/285) | [#284](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/284) |
| 3 | [#286 - Recover torn, invalid and incompatible logs safely](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/286) | [#285](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/285) |
| 4 | [#287 - Preserve drafts across crash-then-sync or restore](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/287) | [#286](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/286) |
| 5 | [#288 - Keep sessions safe through identity changes and exits](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/288) | [#287](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/287) |
| 6 | [#289 - Edit Unicode and selections without corrupting positions](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/289) | [#284](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/284) |
| 7 | [#290 - Drive the first session through Swift and Kotlin](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/290) | [#285](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/285), [#289](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/289) |
| 8 | [#291 - Expose the WASM session and host recovery handshake](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/291) | [#285](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/285) |
| 9 | [#292 - Render and edit inline formatting with hidden markers](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/292) | [#289](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/289) |
| 10 | [#293 - Group typing and commands into exact history](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/293) | [#292](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/292) |
| 11 | [#294 - Handle composition, correction and OS replacements](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/294) | [#293](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/293) |
| 12 | [#295 - Split, join and delete paragraph lines correctly](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/295) | [#293](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/293) |
| 13 | [#296 - Edit headings, quotes and dividers through shared commands](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/296) | [#295](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/295) |
| 14 | [#297 - Edit fenced code without leaking markdown interpretation](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/297) | [#296](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/296) |
| 15 | [#298 - Continue lists and toggle tasks without changing neighbors](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/298) | [#296](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/296) |
| 16 | [#299 - Indent and edit nested list and quote containers](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/299) | [#297](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/297), [#298](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/298) |
| 17 | [#300 - Preserve front matter, HTML and unfamiliar markdown](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/300) | [#299](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/299) |
| 18 | [#301 - Edit links and autolinks without losing destinations](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/301) | [#294](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/294), [#297](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/297) |
| 19 | [#302 - Copy, cut and paste plain markdown with exact whitespace](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/302) | [#299](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/299), [#301](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/301) |
| 20 | [#303 - Paste rich content through one clipboard policy](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/303) | [#302](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/302) |
| 21 | [#304 - Edit body tags and header tags through canonical rules](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/304) | [#300](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/300) |
| 22 | [#305 - Resolve and update wikilinks without whole-note scans](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/305) | [#300](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/300), [#301](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/301) |
| 23 | [#306 - Complete wikilinks through the engine contract](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/306) | [#305](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/305) |
| 24 | [#307 - Describe and edit images and non-text atoms safely](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/307) | [#300](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/300), [#301](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/301) |
| 25 | [#308 - Edit and navigate individual table cells](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/308) | [#299](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/299), [#301](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/301) |
| 26 | [#309 - Change table rows, columns and alignment](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/309) | [#308](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/308) |
| 27 | [#310 - Paste content into table cells and grids](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/310) | [#303](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/303), [#309](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/309) |
| 28 | [#311 - Move rendered blocks without exposing syntax](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/311) | [#307](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/307), [#309](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/309) |
| 29 | [#312 - Find visible note text without adding typing scans](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/312) | [#305](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/305), [#308](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/308) |
| 30 | [#313 - Reinterpret large semantic changes progressively](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/313) | [#300](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/300), [#308](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/308) |
| 31 | [#314 - Bound local editing work at long-note sizes](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/314) | [#313](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/313) |
| 32 | [#315 - Validate the complete contract through native and WASM consumers](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/315) | [#290](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/290), [#291](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/291), [#304](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/304), [#306](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/306), [#310](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/310), [#311](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/311), [#312](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/312), [#313](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/313) |
| 33 | [#316 - Measure core latency and durability on reference devices](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/316) | [#288](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/288), [#314](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/314), [#315](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/315) |
| 34 | [#317 - Complete the shared-core acceptance and renderer handoff](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/317) | [#316](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/316) |

Work from the current integration-branch tip. After each completed blocker, query the newly
unblocked tickets; table order alone is not a required serial schedule. Shared engine edits
still need coordinated integration, and binding/CI updates travel with the owning feature.
