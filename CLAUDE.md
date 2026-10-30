# steekem

Browser-to-browser single-use sharing (text, Wi-Fi, login, card; file
transfer code still present) over WebRTC DataChannels. A small Cloudflare
Worker handles room-pairing signaling only — payload bytes never touch any
server. Encrypted by WebRTC's DTLS plus an application-layer AES-GCM key
derived from a secret in the share link's URL fragment, so even the
signaling worker cannot read the channel (see "Channel encryption").

Live: https://steekem.com (web, Cloudflare Pages project steekem-web) and
https://steekem-signaling.janjetze.workers.dev (signaling).

## Routes

- `/` — landing page with a link to `/send`
- `/send` — sender lobby (drop a file, or paste a 6-char code to receive)
- `/send#abc123` — sender's active session URL, sessionStorage-locked to the
  tab that started it
- `/r#abc123.<secret>` — receiver URL, what the sender shares (QR + copy
  button). `<secret>` is 22 base64url chars (16 random bytes) that both ends
  derive the channel key from; it never leaves the fragment. A typed code
  has no secret (`/r#abc123`) and runs code-only, see "Channel encryption".
  Loading it does not connect: the receiver taps Receive first, so link
  unfurlers, URL scanners and stray tabs never take the room's receiver slot.
  A code typed into `/r` connects immediately (typing it was the consent).
- `/r#abc123.<secret>.p` — same, for a PIN-protected share: the idle card
  asks for the PIN together with the Receive tap. `.p` is only a UI hint; the
  sender enforces the PIN regardless. Parsing lives in `lib/share-link.ts`.
- `/preview/*` — kept design playground; not user-facing
- `/text`, `/wifi`, `/password`, `/card` — the inline-share composers (SendApp
  with `mode`); `/files` redirects to `/`

## Repo layout

```
apps/
  web/                       Astro 5 + Preact, Cloudflare Pages
    src/
      pages/
        index.astro          landing
        send.astro           sender lobby + active session shell
        r.astro              receiver shell
        preview/*.astro      design previews
      islands/
        SendApp.tsx          sender state machine + UI
        ReceiverApp.tsx      receiver state machine + UI
      lib/
        file-sink.ts         capability detection + StreamSaverSink + BlobSink
        session-memory.ts    localStorage outcome marker per code
        ownership.ts         sessionStorage tab-token (sender lock) + link secret
        share-link.ts        build/parse the `code.secret.p` receive hash
      styles/
        global.css           Quiet Room design tokens (light + dark)
      components/
        FakeQr.astro         placeholder QR for previews only
    public/
      sw.js                  service worker — streams downloads to disk

  signaling/                 Cloudflare Worker + Durable Object
    src/
      index.ts               worker entry; routes /room/:id to DO stub
      room.ts                Room DO with WebSocket Hibernation API

packages/
  webrtc-core/               shared WebRTC engine
    src/
      peer.ts                RTCPeerConnection wrapper, channel + ICE, encryption, reset
      crypto.ts              link secret, HKDF key, AES-GCM frames, connection words
      signaling.ts           tiny WebSocket client to the Worker
      index.ts               re-exports
```

## Tech stack

- Astro 5, Preact 10 (web)
- TypeScript everywhere
- pnpm workspaces
- Cloudflare Workers + Durable Objects (signaling)
- Cloudflare Pages (web)
- `qrcode` package, `@steekem/webrtc-core` workspace package
- Inter (variable) + JetBrains Mono 500, self-hosted from `apps/web/public/fonts`

## Channel encryption

Two layers. DTLS is WebRTC's own; on top of it every DataChannel message is
an AES-256-GCM frame (`crypto.ts`): `version(1) | iv(12) | ciphertext`, where
the plaintext is `kind(1: text/binary) | data`. The key is
HKDF-SHA256(secret, salt = room code, info = "steekem-channel-v1"). The iv is
`direction byte | zeros | 64-bit counter`; `Opener` insists on strictly
sequential counters from the expected direction (ordered+reliable channel),
so replays and reordering fail closed.

Why: the signaling worker relays both SDPs and could in principle MITM the
DTLS handshake. The fragment secret never reaches it, so it only ever sees
ciphertext.

Mode is decided by the receiver's first message (`receiver-hello`):

- Receiver opened the link → it has the key → hello is a frame → sender
  decrypts it → `Peer.encryption === "e2e"`. Sender then announces status
  and offer. Receiver runs `plaintext: "reject"`: any plaintext from a
  sender who handed out a keyed link is a `crypto-error` → `link-mismatch`.
- Receiver typed the code → no key → hello is plaintext → sender
  (`plaintext: "allow-downgrade"`) drops its key for this connection →
  `"plaintext"` mode, shown as "code" in SendApp. Only DTLS protects the
  channel, so both ends compute four `connectionWords` (SHA-256 over the
  sorted DTLS fingerprints, PGP even word list) and the sender must press
  "They match, send" before any consent (`data-accept`, `file-accept`) is
  acted on. "They differ, cancel" ends the share (`cancelReason: mismatch`).
  A MITM that downgrades a link share lands in this mode too, and the real
  receiver's screen shows different words (or no words at all).

The sender says nothing on channel-open; `announceSession` runs on the
hello. `Peer.send()` returns a promise that resolves once the frame is
queued on the channel — the file pump awaits it so `bufferedAmount` stays
honest for backpressure.

## Wire protocol over the DataChannel

Receiver → sender, first message after channel open:

```ts
{ type: "receiver-hello", device, e2e }   // e2e: whether this page holds the link secret
```

Sender → receiver (after the hello, every time a peer joins):

```ts
{ type: "session-status", status: "active" | "completed" | "declined" | "aborted", file?: {...} }
```

If status is `active`, the sender immediately follows with:

```ts
{ type: "file-offer", name, size, mimeType }
```

Then waits for `file-accept` and starts pumping raw `ArrayBuffer` chunks of
`CHUNK_SIZE = 256 KB`, clamped down to the connection's negotiated SCTP
`maxMessageSize` (Safari/WebKit advertises 64 KB; sending larger throws or
closes the channel whenever a Safari peer is on either end). Backpressure:
pause when `bufferedAmount > HIGH_WATER` (16 MB), resume on `bufferedamountlow`
(`BUFFERED_AMOUNT_LOW` = 4 MB).

Receiver → sender:

```ts
{ type: "file-accept" }      // user clicked Accept
{ type: "file-reject", reason? }   // user clicked Decline
```

Inline shares (text, wifi, password, card): the offer carries only the kind.
The Receive tap already was the consent, so the receiver sends `data-accept`
straight away, unless the offer requires a PIN:

```ts
{ type: "data-offer", kind }            // sender → receiver, no payload
{ type: "data-accept" }                 // receiver → sender, auto after Receive, or after PIN
{ type: "data-payload", data }          // sender → receiver, sent once
```

The sender marks the session completed as soon as `data-payload` is sent
(not on a receiver ack) and ignores any later `data-accept`.

Extra messages, shared by file and inline shares:

```ts
{ type: "pin-check", pin }              // receiver → sender, when the offer has pinRequired
{ type: "pin-result", ok, attemptsLeft } // sender → receiver
```

- The PIN (4 digits, optional) is set in the composer and fixed for the
  session. Offers carry `pinRequired`; the sender ignores accept/reject until
  the current connection has passed `pin-check`. Only well-formed 4-digit
  guesses count; `MAX_PIN_ATTEMPTS` (3) failures per session, across all
  receivers, cancel the share.
- The receiver never waits on a PIN prompt while connected. It sends the PIN
  typed on the idle card as soon as the offer asks; a wrong PIN drops back to
  idle (disconnecting). Without a PIN in hand (no `.p`, or a typed code) it
  disconnects on seeing `pinRequired` and asks for one.
- `session-status` broadcasts for inline kinds carry only `{ kind }`, never the
  summary (SSID, username, last 4 digits): anyone with the link receives them.
- Inline shares expire after `INLINE_SHARE_TTL_MS` (15 min) if not delivered;
  the sender can also cancel at any time. Both mark the session `aborted` and
  drop the payload from memory.
- A receiver sitting in `reviewing` (file Accept card) for
  `REVIEW_TIMEOUT_MS` (2 min) goes to `review-expired` and disconnects, so an
  idle tab can't hold the room's second WebSocket slot.

End-of-file is implicit: receiver knows the total from the offer and
finishes when bytes ≥ size.

## Room codes

6 characters from `abcdefghjkmnpqrstuvwxyz23456789` (no `i/l/o/0/1`,
hand-typeable, ~887M combos). Generated client-side via `crypto.getRandomValues`.
The code is the only part of the link the worker learns (WebSocket path).

## Sender ownership model

- `claimOwnership(code, secret)` writes a sessionStorage token and the link
  secret at session start; `ownerSecret(code)` reads it back after a refresh
  so ghost mode can still talk to receivers holding the keyed link
- `isOwner(code)` checks for it on subsequent loads of `/send#code`
- sessionStorage survives same-tab refresh but does NOT carry to new tabs,
  so duplicate visits to the sender URL fall through to the "session locked"
  card without trying to recover anything
- localStorage `steekem-room-{code}` records the outcome (completed / declined
  / aborted) so the original tab can re-enter ghost mode after refresh and
  broadcast the right `session-status` to any new visitor

## Session lifecycle

1. Lobby (`/send`, no hash): drop file → `generateCode()` → `claimOwnership` →
   set `window.location.hash` → render share screen
2. WS opens; Worker assigns "sender" role to the first peer
3. Receiver opens `/r#code` and taps Receive → Worker assigns "receiver" → `partner-joined`
   fires on sender → `peer.startNegotiation()`
4. Channel opens → sender sends `session-status: active` + `file-offer`
5. Receiver shows accept/decline → on Accept, opens a `FileSink` and sends
   `file-accept`
6. Sender pumps chunks until `offset >= file.size` → status `done`,
   `rememberSession(code, completed)`
7. Sender stays connected: any future receiver who opens `/r#code` will hear
   the ghost `session-status: completed`
8. Receiver auto-disconnects from the WS once it reaches an end-state, so
   the room slot frees up for late-arriving receivers (Worker caps each
   room at 2 concurrent WebSockets)

## Receiver disk-write paths (`FileSink`)

- `StreamSaverSink` — page registers a transfer with the Service Worker,
  triggers a hidden `<a>.click()` to a synthetic URL, the SW returns a
  streaming `Response` with `Content-Disposition: attachment`. Browser writes
  bytes straight to disk via the native download manager. Used wherever
  `canStreamToDisk()` is true.
- `BlobSink` — accumulates ArrayBuffers in memory, builds a single Blob URL
  on close, exposes a Download button. Fallback for iOS Safari (where SW
  download streaming is broken) and any other env without SW support.

`canStreamToDisk()` returns false for iOS Safari (UA-detected) regardless of
SW availability.

## Service Worker

`apps/web/public/sw.js` keeps a `Map<id, transfer>` of in-flight downloads.
Two flag bits per entry — `fetched` and `ended` — gate cleanup so the entry
isn't dropped while either side is still in progress (covers the case where
a tiny file's `end` message arrives before the browser dispatches its fetch).

The page handshakes via `MessageChannel` for the `register` step so we know
the SW has the entry before we click the anchor; subsequent `chunk`/`end`
messages are fire-and-forget with `postMessage` ownership transfer for
ArrayBuffers.

## Status state machines

`SendApp.tsx` (sender side):

```
lobby → connecting → waiting ↔ negotiating → offered →
                                 ↓ (file-accept / data-accept; on a code-only
                                 ↓  connection held until the sender confirms
                                 ↓  the connection words)
                              transferring → done
                                 ↓ (file-reject)
                              rejected
negotiating/offered → waiting   ← ICE failed, ICE disconnected > 5 s, no channel
                                  20 s after partner-joined, or crypto-error:
                                  Peer.resetConnection(), `connectIssue` notice
                                  on the share card, share stays valid
                                 ↑ refresh-with-marker
locked  ← (non-owner tab)        ↑ refresh-mid-flow → back to lobby
error   ← (connect / signaling failure)
```

`ReceiverApp.tsx`:

```
idle (link opened, waiting for Receive tap [+ PIN]; no WS yet) →
connecting → negotiating → awaiting-offer →
   ↓ session-status            ↓ file-offer / data-offer (pin-check first if pinRequired;
   │                             wrong PIN or no PIN in hand → back to idle, disconnected)
   ├ active  ─┬ file → reviewing ─┬ (accept) → transferring → done (sink-mode = stream | blob)
   │          │                   └ 2 min idle → review-expired
   │          └ data → data-accept → (data-payload) → data-shown
   ├ completed → remote-completed
   ├ declined  → remote-declined
   └ aborted   → remote-aborted   (also: sender canceled, expired, PIN lockout)

awaiting-offer + 5s timeout → sender-offline
connecting/negotiating for 20 s, ICE failed, or ICE disconnected > 5 s → connect-failed
  (explains NAT/VPN/sleeping tab; "Try again" reconnects with the same PIN)
crypto-error (plaintext or undecryptable frame on a keyed link) → link-mismatch
WS upgrade fails → 1× retry after 2s → error
end-state → auto-close WS (free the room slot)
```

## Dev workflow

Container is `node:22-slim` (NOT alpine — `workerd` needs glibc).

```sh
docker compose up        # both apps in one container, with bind-mount of host wrangler creds
docker compose down      # stop
```

- Astro on `http://localhost:4322` (host 4322 → container 4321; 4321 left
  free for other projects)
- Wrangler on `http://localhost:8787`
- Vite is configured with `server.watch.usePolling: true` because macOS
  Docker bind-mounts swallow inotify events

Typecheck the web app:

```sh
docker compose exec dev sh -c "cd /workspace && pnpm --filter @steekem/web typecheck"
```

## Deploy

Deploys go through GitHub Actions only, so the public workflow logs tie
every deployed build to a commit (see "Verifiable builds"):

- push to `master` → `.github/workflows/deploy-dev.yml` → worker
  `steekem-signaling-dev` + Pages project `steekem-web-dev`
- push a tag `vX.Y.Z` → `.github/workflows/deploy-prod.yml` → worker
  `steekem-signaling` + Pages project `steekem-web` (steekem.com)

```sh
git tag v1.2.0 && git push origin v1.2.0
```

Both workflows need the repository secrets `CLOUDFLARE_API_TOKEN` (Workers
Scripts: Edit, Cloudflare Pages: Edit, Account Settings: Read) and
`CLOUDFLARE_ACCOUNT_ID`. The Pages projects' production branch is
`master`; any other `--branch` value only creates a preview deployment.

Wrangler also runs in the dev container with the host's OAuth login
bind-mounted from `~/Library/Preferences/.wrangler` (re-auth with
`wrangler login` natively on the Mac). That is for `wrangler dev` and
inspection; a manual deploy from the container would serve a build no
public log can account for, so don't.

## Verifiable builds

`astro.config.mjs` injects `__BUILD_COMMIT__`, `__BUILD_TIME__` and
`__BUILD_RUN_URL__` via `vite.define` (from `GITHUB_SHA`, `GITHUB_RUN_ID`
etc. in Actions; `git rev-parse HEAD` locally; "unknown" in a container
without git). `/version.json` (prerendered endpoint) and the footer of
`/how-it-works` expose them, linking to the commit and the Actions run.

## Constraints worth knowing

- Worker `Room` DO caps each room at 2 concurrent WSs. The receiver-side
  auto-disconnect on end-state is what allows new receivers to join an
  already-completed sender's ghost session. Do not break this.
- iOS Safari has no working SW download streaming → BlobSink only, ~1 GB
  practical cap from RAM.
- File handles are in memory only. A sender refresh mid-transfer drops back
  to the lobby; there is no resume mechanism (the SW hands off to the
  browser download manager and we can't reclaim the stream).
- WebSocket Hibernation: the DO uses `state.acceptWebSocket` and
  `webSocketMessage`/`webSocketClose` callbacks. Don't add instance fields
  expecting them to survive eviction; per-WS metadata goes through
  `serializeAttachment`.
- All code on the receiver UI branches on `intent === "receiver"` not
  `role === "receiver"`. Intent is set by the URL route (`/r` always
  receiver; `/send` sender). Role is what the Worker assigns; mismatch
  means the room is in a weird state and we surface that as
  `sender-offline` (receiver) or an error (sender).

## Conventions

- Docker-first: never run `pnpm install`, `astro build`, `wrangler ...` on
  the host. The container has the right glibc + node + workerd combination.
- No emojis in committed code or copy.
- No comments that describe what the code does — only the *why* when it's
  non-obvious (a constraint, a workaround, a hidden invariant).
- Design tokens come from `src/styles/global.css`. Don't introduce new
  accent colors; reuse `--accent` / `--success` / `--danger` / `--warn`.
