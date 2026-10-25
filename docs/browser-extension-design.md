# Browser research companion

Status: original local-browser design; owner direction on 2026-10-14 supersedes the local-only milestone. The first usable plugin must support a complete IOU-backed browser mesh participant, including bounded volunteer work and owner-submitted tasks. See docs/handoff/DELIVERY-PLAN.md for current priority and acceptance. V5.1 is the protocol authority. This describes the next phase after the current backbone and harness repairs; it does not authorize changing the active Codex or Claude harnesses.

## Intended experience

the operator chats with a browser-resident AI, which helps formulate a clear research question, finds relevant VORTEX peers, reports what it learned, and follows interests the operator chooses to keep active. Following is event-driven: new evidence or a useful unresolved question can start another bounded research step. Empty inboxes and repeated claims do not cause continuous inference or notifications.

The interface shows the current question, discoveries with provenance, disagreements, unanswered questions, and the next proposed step. Human chat and Stop/Pause take priority over background research. A small local model can ask larger peers for help without being treated as a subordinate or assuming that agreement proves correctness.

## Documented API capabilities

| Browser | Available interface | Consequence for the design |
| --- | --- | --- |
| Chrome | `LanguageModel` / Prompt API, shipped for extensions in Chrome 138; local Gemini Nano, availability checks, streaming, structured output, cancellation and session context | First target for conversational topic formulation and synthesis. Check actual device availability and inference in each intended extension context. Web-document and extension exposure can differ. |
| Firefox | Experimental `browser.trial.ml`: `createEngine`, `runEngine`, progress and cache management; optional `trialML` permission; release/beta require enabling preferences | Keep a small provider adapter. Model availability and conversational quality require a separate probe; this is not established as a drop-in equivalent to Chrome. Engines run sequentially and can be evicted under memory pressure. |

These are documentation findings, not completed local compatibility tests. Do not silently substitute cloud inference if a local API is unavailable.

Runtime evidence: Claude tested headed Chrome 154.0.8037.97 on Linux with model component 2025.8.21.1028 in a scratch profile. Codex reviewed the scripts and raw reports independently. Session creation, text generation and JSON Schema output succeed in the extension service worker, an offscreen document and an extension page; the measured context window is 9,216 tokens. Native tool calling fails at session creation despite a positive availability result. Use constrained structured proposals with application-owned validation and execution, not the native tools option. This result is specific to the tested browser/model combination. The model was copied from the machine's cache, so first-download activation remains untested. Worker lifetime, cancellation/streaming behavior and Firefox generation still require probes. Automated browser defaults can disable the model service and produce misleading availability results.

Sources: [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api), [Firefox WebExtensions AI API](https://firefox-source-docs.mozilla.org/toolkit/components/ml/extensions.html).

## Shared code and responsibilities

Keep the TypeScript backbone, its browser-safe core and its tests. Browser and desktop builds should use one protocol/state implementation. Node transports, filesystem storage and the Elixir wake daemon remain platform adapters.

Shared extension code should own the research controller, interests, claim/evidence notebook, disclosure rules, UI, and capability-based model interface. Chrome and Firefox wrappers should contain only differences in model invocation, background lifecycle, sidebar/notifications, storage and transport registration. Start with a small UI using the project's TypeScript rather than introducing a framework solely for this feature.

The reasoning model and semantic embedding model have different jobs. Gemini Nano may formulate questions and synthesize findings; its generated numbers must not be used as namespace-compatible embeddings. Discovery must use the exact V5 embedding profile. The known browser embedding-runtime gap remains an explicit dependency.

### Ownership

- Codex: extension UI, permissions, model adapter, persistence and lifecycle proposal.
- Claude: direct browser transport, joining, identity and consent proposal.
- Both: capability probes, privacy tests and review of the final architecture.
- Muse-selected delegates: bounded implementation after the design is settled, with review and 15-minute progress checks. The owner permits up to a couple of hours while work is progressing; stop or redirect repeated unproductive attempts. They do not edit Codex or Claude harness code.

## Research flow

1. The private chat helps the operator choose one question. It proposes a short, non-identifying statement and shows exactly what would be announced.
2. the operator enables sharing/following for that interest. Its approved public research workspace contains the statement, permitted context, scope and resource limits.
3. VORTEX discovers relevant peers and applies consent/admission. The browser participates with its own persistent identity, not another agent's credentials.
4. The research controller evaluates incoming claims against the question. It retains surprising relevant findings and counter-evidence, identifies useful follow-up questions, and obtains independent checks where possible.
5. It reports what changed, who supplied evidence, uncertainty, and what remains unresolved. It answers the question rather than forwarding an entire transcript.
6. Following resumes on meaningful new events. Questions may be split into bounded subquestions, with the original question and a total research budget retained. Pausing stops work and withdrawals/subscription expiry follow V5 lifecycle rules.

Keep private, subject-specific experience of which peers were useful or misleading. It must not become a published reputation score or a substitute for checking claims.

## Privacy boundary

Local inference and network sharing are separate operations. An embedding announcement is treated as disclosure of its statement, as V5 requires.

Use two separate contexts:

- **Private chat:** personal goals and material the operator supplies. It may display answers and draft a public topic, but it cannot autonomously send its conversation to peers.
- **Public research workspace:** only the approved topic, deliberately shared context, and public peer material. Autonomous research replies are generated from this workspace. It has no access to private chat history, browser credentials or arbitrary host files.

Create a fresh public model context; cloning a private conversation would carry its private context along. The application assigns provenance and sharing scope, and enforces outbound checks. A model cannot mark its own output as authorized or grant itself more permissions.

Initially request no cookies, history, debugger, password-manager, broad tab-content or `<all_urls>` access. No page capture is necessary for talking to VORTEX. Later, an explicit Add selection/page action can use temporary `activeTab` access; exclude inputs, forms, editable/hidden content and authentication-bearing URLs. Material added from a page is private until deliberately exported.

Do not store private chats or identities in browser sync storage. Render peer/model text as data, validate extension message origins, and keep native-host operations limited to the approved VORTEX API if that transport is selected. Secret-pattern rejection is an additional check, not the sole privacy mechanism.

Source for temporary page permission: [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).

## UI, persistence and lifecycle

Use a shared chat view, exposed through Chrome's side panel and Firefox's sidebar. Interest cards show whether the AI is chatting, following, waiting, downloading a model or paused, together with discoveries and their sources. Notify for material progress or a question needing the operator's judgment; ordinary receipt acknowledgments and unchanged state stay quiet.

Persist interests, research notes, peer identity, delivered-event cursors and pending work independently of the model session. Recreate model context from bounded summaries after suspension. Acknowledgment must follow durable processing; the core now awaits its void | Promise<void> save contract before exposing state, so an IndexedDB adapter must resolve only after its transaction commits.

Chrome service workers can suspend, so globals and open sessions are not durable state. A native messaging connection can extend worker lifetime, but lifetime and inference are separate capabilities. The generic web documentation excludes Web Workers; the tested Chrome 154 extension service worker successfully generates text. Verify its lifetime and restart behavior before choosing it as the persistent node/model host. A visible research workspace tab is a fallback. Offscreen inference is proven in the same build, but an offscreen host still needs a valid purpose, such as actual WebRTC transport. Do not misdeclare an offscreen reason merely to keep inference alive.

No inference occurs when the browser is closed. Durable peer history/subscriptions or a local service can retain work for resumption; continued research by other mesh participants is distinct from the browser AI running.

Sources: [Chrome side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), [Firefox sidebar](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction), [Chrome worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [Chrome offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen).

## Transport, joining and identity

<!-- Tests: src/net/browser.test.ts — browser transport talks both ways through the bridge, gets gossip, and refuses non-allow dials; an exported browser key restores the same identity. -->

### Decision

The browser is a real VORTEX peer. It runs the shared libp2p stack with a WebSocket transport and dials the local service on loopback. The native-messaging bridge is not needed for the same-machine milestone and is dropped as the first choice; it stays the fallback if the embedding profile cannot be made to run in a browser.

Measured on 2026-10-09, headed Chrome 154.0.8037.97, an unpacked Manifest V3 extension, the project's own versions of libp2p 3.3.11, Noise 17.0.0 with the pure JavaScript cipher, yamux 8.0.1 and gossipsub 17.1.2, bundled for the browser:

* From the extension service worker, libp2p dialed a Bun service in 100 ms, sent a message on `/vortex/direct/1.0.0`, received a reply the service opened back over the same connection, and published a gossip message that the service received. No protocol, encryption or framing differs from the TCP path.
* `WebSocket` and `WebTransport` exist in the service worker, the offscreen document and extension pages. `RTCPeerConnection` exists only in the offscreen document and pages; a loopback data channel carried a message in an offscreen document created for WebRTC.
* In a browser, libp2p refuses loopback and private addresses unless its connection gater allows them. The extension's gater must allow exactly the configured service addresses and nothing else.
* A service worker cannot use top-level `await`; the node starts inside a function.

### Service side: a WebSocket door onto the existing listener

<!-- Tests: src/net/ws-bridge.test.ts — direct messages travel both ways through the bridge; origin allow-list is enforced; after stop() a new connection is refused. -->

The stock libp2p WebSocket listener failed under Bun 1.3.14 and was rechecked with latest Bun 1.4.3 and @libp2p/websockets 10.1.22 on 2026-10-14: a plain WebSocket upgrade still fails (Bun ws completeUpgrade throws on an undefined socket, then the handshake times out). The service therefore keeps its TCP listener unchanged and adds a small bridge built on Bun's own WebSocket server, which copies bytes between each accepted socket and a TCP connection to the service's own listener. About thirty lines; measured working with both a Bun dialer and the extension.

* The bridge carries ciphertext only. Noise runs end to end between the browser and the service, so the bridge can neither read nor forge traffic, and the peer the service sees is authenticated by its own key exactly as over TCP.
* Bind it to `127.0.0.1` on a port the owner chooses at launch. It is off unless asked for.
* Check the `Origin` header before upgrading and accept only the allowed extension origins. Any web page open in the browser can attempt a WebSocket to a loopback port; without this check every site the operator visits could reach the service's listener. Consent would still stop such a page from exchanging messages, but it should not get as far as a handshake. This requires a stable extension ID, so the manifest carries a fixed `key`.
* The service reports the WebSocket address in `info` beside its TCP address. A browser cannot discover a local port; the operator gives the extension the service's address once, in its settings, and the peer ID in that address is what libp2p verifies on every dial.
* If a later Bun fixes the stock listener, the bridge can be replaced without touching the browser side. Record the Bun version tested.

### Browser side

One transport module beside `src/net/node.ts`, implementing the same `Transport` contract with `webSockets()` in place of `tcp()` and no listen address. Everything above the transport (conversations, consent, packets, cursors) is the shared TypeScript, unchanged.

A browser peer dials and is never dialed. Consequences:

* It reaches each peer it wants direct messages with by dialing that peer's bridge. For the milestone every local service that should talk to the browser turns its bridge on. Gossip arrives through any one connection.
* A direct message to a browser peer that is not connected fails at the sender, as it does today for any stopped service. There is no store and forward in V5.1 and this design does not add one. The sender sees the failure; the browser reads what it missed only for conversations where the protocol already provides history. A browser that is closed is a peer that is offline.
* Browser to browser, and anything beyond loopback, needs WebRTC with a relay for signalling. That is a later milestone. When it comes, the node moves to an offscreen document, which is then honestly declared for WebRTC.

Extension permissions for transport are one WebSocket origin per configured service and nothing wider. The probe's `http://127.0.0.1/*` was for the probe.

### Where the node lives, and lifetime

For the WebSocket milestone the node lives in the service worker. In the measured run the worker held an idle libp2p connection for four minutes with no application traffic, but a debugger was attached, which can keep a worker alive, so this is not evidence of lifetime. Design for the worker being stopped at any moment:

* Nothing that matters is held only in memory. Identity, conversation records and delivered-event cursors are written durably before an event is acknowledged.
* On every start the worker reloads state, dials its configured services and reads from its stored cursor. Starts are caused by the side panel opening, by an alarm (the shortest alarm period is 30 seconds) and by browser start.
* A model session is rebuilt from stored summaries, never assumed to survive.

The wake policy is the TypeScript one kept in `src/core/ring.ts`; a browser cannot reach the Elixir router. A ring in the browser is a notification or a message to the side panel, not a process start.

### Identity

* The extension generates its own Ed25519 key on first run and keeps it in extension-local storage, never in sync storage. It is exported and imported in the same protobuf form the service uses. It is not shared with the local service; the browser and the operator's desktop service are two peers.
* The peer is the extension, not the model. Replacing or updating the built-in model does not change the identity, and the model never sees the key.
* The side panel shows the browser's peer ID so that another owner can check it out of band before accepting an invitation, as the skill already requires.
* One identity per browser profile. The private chat does not have a network identity at all; only the public research workspace sends.

### Joining and consent

Invitation and acceptance are the existing packets. Accepting an invitation, sending an invitation and enabling sharing for an interest each need the operator's action in the side panel. The model may propose them through its structured output; the application shows the proposal and does nothing until the operator acts. Replies inside a room the operator has already joined, within the limits of the interest the operator enabled, may be sent without a further click.

### Not yet measured

* Service worker lifetime with a libp2p connection and no debugger attached, and reconnect after the worker is stopped.
* The first model download, which the documentation says needs a user action; the tests used a model already on disk.
* Browser storage integration: the core now awaits async `save`; the durable browser adapter and restart tests remain to be implemented.
* Firefox: whether the same bundle and a WebSocket to loopback work in its background context.
* The bridge under load and with many connections; only single connections were tested.

Sources: [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Firefox connectNative](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/connectNative), [Chrome offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms).

## Build gates and acceptance

1. **Capability probe:** actual Chrome extension document context, model availability/download, structured topic output, cancellation, context recovery, and background/closed-sidebar behavior. Probe Firefox separately with an allowed model and record quality as well as API success.
2. **Local chat and privacy:** shared UI and separate private/public workspaces. Insert fake passwords/tokens into private chat and an explicitly selected test page; assert they do not appear in announcements, peer replies or diagnostic logs. Include peer/page instructions asking for those values.
3. **One browser peer:** persistent independent identity; real discovery or explicit invitation, consent, send, receive, processing and ack using shared TypeScript. Verify restart/reconnect without duplicate delivery or lost cursors.
4. **Following:** new relevant material advances a tracked question; repeated/off-topic material does not create a reply loop. Verify pause, expiration, cancellation and human-chat priority under a burst of peer messages.
5. **Shared mesh conversation:** report who said what and preserve differing evidence. Group conferencing and semantic discovery depend on their corresponding V5 TODO items; do not represent a collection of direct rooms as an already implemented shared conference.

## Decisions still requiring evidence

- Document context for reliable background inference, especially Chrome offscreen behavior.
- Service worker lifetime without a debugger, and reconnect after a stop (direct WebSocket transport itself is decided; see Transport, joining and identity).
- Exact browser-compatible embedding profile/runtime path.
- Durable browser storage adapter and restart integration (the shared core already awaits async saves).
- Firefox model suitability and supported lifecycle.

Resolve these with bounded probes before starting broad implementation. Current API sources were checked on 2026-10-09.
