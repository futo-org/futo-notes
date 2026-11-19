# Current editor spec review

All 50 files under docs/spec/editor/ were read, including the portable-core and historical shipping-editor sections. This is a source review, not runtime verification. Snapshot: 396c7a29d2cbb72984adc4499b702b77ce267112, 2026-11-10.

| File                                                        | Bytes | Review |
| ----------------------------------------------------------- | ----: | ------ |
| android-ime.md                                              |   986 | full   |
| code-fence-isolation.md                                     |   267 | full   |
| cursor/a-note-the-editor-cannot-hold.md                     |  1383 | full   |
| cursor/blank-editor-surface.md                              |  1805 | full   |
| cursor/native-touch-and-focus.md                            |  2189 | full   |
| cursor/placement.md                                         |   723 | full   |
| cursor/selection/block-drag-autoscroll-release-and-touch.md |  6946 | full   |
| cursor/selection/block-drag-lifting-and-drop-slots.md       | 14806 | full   |
| cursor/selection.md                                         |   213 | full   |
| cursor/typing-and-ime.md                                    |   617 | full   |
| cursor.md                                                   |   319 | full   |
| desktop/editing.md                                          |  9168 | full   |
| editor-exits.md                                             | 13651 | full   |
| external-links.md                                           |  4454 | full   |
| find-in-note.md                                             | 11556 | full   |
| images.md                                                   | 14927 | full   |
| interactive-elements.md                                     | 16108 | full   |
| localization.md                                             |   682 | full   |
| markdown-elements.md                                        | 10549 | full   |
| markdown-house-style.md                                     | 12132 | full   |
| markdown-toolbar/native-toolbar-chrome.md                   |  9852 | full   |
| markdown-toolbar/toolbar-commands.md                        | 12821 | full   |
| markdown-toolbar.md                                         |   572 | full   |
| mobile.md                                                   |   738 | full   |
| native-host-boot.md                                         |  2560 | full   |
| paragraphs-and-lines.md                                     |  6185 | full   |
| performance.md                                              |  9606 | full   |
| portable-core/block-commands.md                             | 12905 | full   |
| portable-core/clipboard.md                                  |  6807 | full   |
| portable-core/fenced-code.md                                |  6093 | full   |
| portable-core/find.md                                       |  3193 | full   |
| portable-core/foreign-content.md                            |  3347 | full   |
| portable-core/images.md                                     |  3926 | full   |
| portable-core/interpretation-and-input.md                   | 19527 | full   |
| portable-core/links.md                                      |  5883 | full   |
| portable-core/lists.md                                      | 17785 | full   |
| portable-core/long-regions.md                               | 10427 | full   |
| portable-core/recovery.md                                   |  8837 | full   |
| portable-core/remaining-work.md                             |  6507 | full   |
| portable-core/tables.md                                     |  5387 | full   |
| portable-core/tags.md                                       |  1842 | full   |
| portable-core/transports.md                                 |  6566 | full   |
| portable-core/wikilinks.md                                  |  4786 | full   |
| portable-core.md                                            |  2014 | full   |
| saving-and-rename.md                                        | 19875 | full   |
| tag-bar.md                                                  |  1326 | full   |
| tags.md                                                     |  1136 | full   |
| theming.md                                                  |  4734 | full   |
| wikilinks.md                                                |  9100 | full   |
| wysiwyg-rendering.md                                        |  2827 | full   |

Reconciled reversals: selected source versus visible-text Find; native Back versus desktop save-before-exit; canonical quote and middle-list work bounds; stale list comment and indentation rules superseded by !604/!632.
