## Suggested order

| #   | Workstream                                       | Why this position                                                                  |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | GPU renderer gating                              | Smallest change, and every later feel judgment should be made with the GPU path on |
| 2   | Portal plumbing over zbus                        | Provides the desktop-settings reader that 3 and 4 also want                        |
| 3   | One header row: window controls in the top band  | Largest visible change                                                             |
| 4   | ~~System font for the interface~~ (dropped)      | Installed-build review preferred the established Barlow identity                   |
| 5   | Desktop entry, markdown association, open-a-file | Independent, but the launcher test wants 3 landed so screenshots are final         |
| 6   | File dialogs through the portal                  | Independent, one Cargo change plus verification                                    |
| 7   | Ctrl+Q                                           | Trivial, do it whenever                                                            |

One MR per workstream, branched from `main`, merged into `main`. `linux-native-feel` is the
integration branch for anyone who wants to see them together. Workstreams 1, 6 and 7 are each
small enough to land the same day they are started.

---
