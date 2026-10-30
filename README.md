# steekem

Single-use, browser-to-browser sharing of small secrets: a text snippet, a
password, Wi-Fi credentials or card details. Nothing is uploaded. The two
browsers connect directly over a WebRTC DataChannel; a tiny Cloudflare
Worker only pairs them.

Live at [steekem.com](https://steekem.com). How it works, in detail:
[steekem.com/how-it-works](https://steekem.com/how-it-works).

## What makes it different

- **No server ever holds the payload.** The Worker relays the WebRTC
  handshake and nothing else. Room state lives in memory and dies when both
  sides leave.
- **Encrypted end to end, including against us.** WebRTC's DTLS protects the
  channel against everyone except whoever runs signaling, so the share link
  carries a second secret in the URL fragment (never sent to a server). Both
  ends derive an AES-256-GCM key from it and encrypt every message with it.
  A receiver who typed the code instead of opening the link gets a
  four-word fingerprint check that the sender confirms before releasing
  anything.
- **Single use.** The payload is released only after the receiver taps
  Receive (and passes the optional PIN), and exactly once. Later visitors
  see "already used". Unopened shares expire after 15 minutes.
- **No accounts, no analytics, no third-party requests.** Fonts are
  self-hosted; STUN runs on Cloudflare.

## Layout

```
apps/web          Astro + Preact front end (Cloudflare Pages)
apps/signaling    Cloudflare Worker + Durable Object that pairs two browsers
packages/webrtc-core
                  RTCPeerConnection wrapper, signaling client, channel encryption
```

[CLAUDE.md](CLAUDE.md) documents the wire protocol, the encryption layer,
the state machines and the dev workflow in depth.

## Running it locally

Everything runs in Docker; nothing needs to be installed on the host.

```sh
docker compose up
```

- Web app: http://localhost:4322
- Signaling worker: ws://localhost:8787

Typecheck:

```sh
docker compose exec dev sh -c "cd /workspace && pnpm --filter @steekem/web typecheck"
```

## Verifying what is deployed

Open code proves what the code does, not that steekem.com serves it, so the
chain is kept visible: deploys run only from the GitHub Actions workflows in
this repository (public logs), and every build is stamped with its commit.
[steekem.com/version.json](https://steekem.com/version.json) names the
commit and the Actions run behind the live site; the footer of
[how-it-works](https://steekem.com/how-it-works) shows the same.

## Known limits

- Both tabs have to stay open during a share. There is no resume.
- There is no TURN relay. Peers behind strict NATs, VPNs or some mobile
  carriers cannot reach each other and get a clear failure with a retry.
- iOS Safari cannot stream downloads to disk, so file transfers there are
  held in memory.

## License

[AGPL-3.0](LICENSE). Run it, change it, host it; if you host a modified
version, publish your changes under the same terms.
