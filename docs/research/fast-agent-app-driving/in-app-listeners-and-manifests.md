## Q1. In-app debug command listeners and action manifests

### Shipped in products

**Shopify — AppCLI / Tardis [prod, internal].** Already covered in the sibling file. Two additions
from re-reading the Shop-app post: Tardis gives agents "structured access to live native app events,
logs, and state, along with the ability to send commands to the app", and for parity review it
captured "screenshots and event windows from the React Native and native apps at named checkpoints"
with raw event capture so agents "could compare event names, counts, and payload fields"; the
comparison instructions "accounted for values that naturally differed between runs, like timestamps
and page UUIDs". The migration used the Pi coding agent; "Plan acceptance was tied to a hash of its
contents: changing a plan invalidated its previous acceptance." Transport remains UNVERIFIED
(nothing published; a Shopify engineering deep-dive is promised).

**Android 16 AppFunctions [prod, OS API].** OBSERVED (developer.android.com/ai/appfunctions):
"AppFunctions is an Android platform API with an accompanying Jetpack library to simplify Android
MCP integration. It empowers your apps to behave like on device MCP servers, contributing functions
that act as tools for use by proactive features along with agents and assistants, like Google
Gemini." "AppFunctions serve as the mobile equivalent of tools within the Model Context Protocol
(MCP)." Mechanics: annotate with `@AppFunction`, `@AppFunctionSerializable`,
`@AppFunctionServiceEntryPoint`; "The AppFunctions Jetpack library generates an XML schema file that
lists all the declared AppFunctions in the app. The Android OS uses this file to index the available
AppFunctions." Callers discover through AppSearch (`AppFunctionSearchSpec`) and execute via
`AppFunctionManager` / `ExecuteAppFunctionRequest`; "Callers must have the `EXECUTE_APP_FUNCTIONS`
permission". Status: "As of May 2026, AppFunctions integration with Gemini is in a private preview
with trusted testers." Requires Android 16 and `compileSdk` 36. Manifest shape: static, build-time
XML index of typed functions — *not* per-screen and *not* data-dependent, unlike Shopify's
`OpenMedia:<gid>`.

**Windows App Actions [prod, OS API].** OBSERVED (learn.microsoft.com/windows/ai/app-actions):
"Actions are defined using a JSON format that provides metadata about one or more actions, which
includes information like the unique identifier and description for the action as well as the list
of inputs and outputs that the action operates on." Implementation is "handling URI launch
activation, or … COM activation by implementing the **IActionProvider** interface"; "Apps must have
package identity in order to register an app action." Inputs/outputs are typed *entities*
("Document, Photo, and Text"). Same character as AppFunctions: a static manifest of atomic verbs
for the OS to recommend, with no runtime screen context.

**Apple App Intents [prod, OS API].** OBSERVED (WWDC25 session 275): "By using NSUserActivities,
your app has the ability to associate entities with onscreen content. This allows people to ask
ChatGPT about things currently visible in your app." — entities conform to `Transferable`. WWDC26
session 343 adds display-representation queries so "Siri resolves on-screen entities fast", the
`OwnershipProvidingEntity` protocol for confirmation decisions on shared entities, and
`IndexedEntityQuery` for Spotlight reindexing; the `.system.search` schema was renamed
`.system.searchInApp`. Session 347 ("Secure your app: mitigate risks to agentic features") is the
first WWDC session on indirect prompt injection against App Intents / Foundation Models. This is the
only vendor manifest with a *screen-context* notion (on-screen entities), but it is user-facing:
there is no documented developer path to enumerate or invoke a running app's intents from a test
harness beyond Shortcuts/Spotlight. The framework landing page is JS-rendered and returned only its
title to automated fetch; the transcripts above are the primary evidence.

### Debug-time listeners (the archetype and its descendants)

**Chrome DevTools Protocol [prod, oss].** OBSERVED: "The protocol is split into a number of domains
(DOM, Debugger, Network etc.). Each domain defines a number of commands it supports and events it
generates. Both commands and events are serialized JSON objects of a fixed structure." Exposed with
`--remote-debugging-port`; discovery at `/json/version`, per-target WebSocket at
`/devtools/page/{targetId}`; the browser pushes events such as `Inspector.detached`. This is the
model every in-app listener below copies: one long-lived socket, JSON commands with ids, unsolicited
events on the same socket, a discovery HTTP endpoint.

**React Native dev-middleware / RN DevTools [prod, oss].** OBSERVED (facebook/react-native
`packages/dev-middleware` README): the dev server exposes CDP-compliant `GET /json/list, /json` that
"Returns the list of available WebSocket targets for all connected React Native app sessions",
`GET /json/version`, a `/inspector/device` WebSocket for "registering device connections" and
`/inspector/debug` that "proxies CDP messages to/from the corresponding device". RN 0.76 shipped
"A fully featured debugger based on Chrome DevTools" on "a new backend debugging stack". Debug
builds only. This is why Metro-attached MCP servers can drive an RN app with no app code changes:
`Runtime.evaluate` over the existing CDP socket. FUTO Notes' `scripts/cdp-invoke.mjs` is the same
trick against the Android WebView.

**Expo DevTools plugins [prod, oss].** OBSERVED: "enables two-way communication between the app and
an external Chrome window" through the dev server; app side is `useDevToolsPluginClient` with
`client?.sendMessage("ping", { from: "app" })` / `client?.addMessageListener("ping", …)`; "The hook
and any functions returned from it will no-op when the app is not running in development mode."
A pluggable, dev-only, named-message channel — the minimum viable "in-app command listener".

**Reactotron [oss].** OBSERVED: `Reactotron.onCustomCommand({ command, handler, title, description,
args: [{ name: "route", type: ArgType.String }] })`; registered commands appear in the desktop
"Custom Commands" tab; shipped as "a dev dependency so it adds nothing to your production builds".
This is the closest open-source precedent to Shopify's manifest: a self-describing list of named
commands with typed args, registered by the app at runtime. Transport/port not stated in the docs
fetched (UNVERIFIED; reading `reactotron-core-client` would settle it).

**Flipper [oss, archived].** OBSERVED: "This repository was archived by the owner on Sep 26, 2025.
It is now read-only." Meta's own in-app debug plugin host is dead; do not cite it as current
practice.

**Maestro [oss].** OBSERVED via code search: the iOS driver is an XCTest runner app hosting an HTTP
server — `HTTPServer(address: try .inet(ip4: "127.0.0.1", port: port ?? 22087))`
(`maestro-ios-xctest-runner/…/XCTestHTTPServer.swift`), documented in CONTRIBUTING.md as "the HTTP
server that runs inside the XCTest runner app (by default on port 22087)"; the Android driver uses
gRPC (`maestro-android/build.gradle.kts` generates `protoc-gen-grpc-java`; `maestro-proto/` holds
the definitions). Maestro's public docs describe this only as "a small companion driver app on the
device". These are *driver* listeners (tap/swipe/tree), not app-semantic ones, but they are the
proof that a loopback HTTP server inside an XCTest host is a normal, shippable pattern.

**Detox [oss].** OBSERVED: "Communication between the two parts takes place over the network using a
web socket"; "both parts are implemented as clients and communicate through a Detox server that acts
as mediator" so either side can disconnect without losing state. Detox is gray-box: it "monitors
these changes in the app's state and waits for them to complete" (network, timers, animations, RN
layout/shadow queue). Relevant because *idle detection is done in-process*, which is what makes the
harness never need `sleep()`.

**agent-device [oss].** OBSERVED: iOS simulators use "a local accessibility bridge", everything else
XCTest; Android uses "ADB and the snapshot helper". ADR 0002 describes the Android helper as a
bundled process holding "a live `UiAutomation` context" that will "serve fresh snapshot requests over
an `adb forward` socket" with "a small validated protocol with request ids and version metadata".
ADR 0003 splits a public `command-catalog.ts` from a daemon-side `daemon-command-registry.ts` that
owns "route ownership and daemon request-policy traits". So agent-device *has* a persistent in-device
listener — but it is generic (tree + gestures), not app-semantic.

### What a manifest looks like across these

| System | Unit | Typed args | Runtime/screen-scoped | Data-dependent entries | Discovery |
|---|---|---|---|---|---|
| Shopify AppCLI (sibling file) | `Name <JSON Schema>` | yes | per current screen | yes (`OpenMedia:<gid>`) | `ls` in REPL |
| Android AppFunctions | `@AppFunction` fn | yes (serializable) | no (static XML index) | no | AppSearch + `AppFunctionManager` |
| Windows App Actions | JSON action + entities | yes | no (package manifest) | no | OS registry |
| Apple App Intents | `AppIntent` / `AppEntity` | yes | partial (on-screen entities) | via entity queries | Siri/Shortcuts/Spotlight |
| Reactotron custom commands | `{command, args[]}` | yes (ArgType) | app-registered at runtime | no | desktop tab |
| CDP | domain.command | yes (protocol JSON) | per target | n/a | `/json/list` |
| FUTO iOS prototype | `GET /actions` → `{name, schema}` | yes | global list, 5 verbs | no | `GET /actions` |

INFERRED (high): Shopify's is the only one that combines *typed*, *per-screen*, and
*data-dependent*. The OS manifests prove typed verbs scale to thousands of apps; the debug listeners
prove the transport is trivial; nobody but Shopify has published the join.
