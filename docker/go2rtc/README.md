# Home Agent go2rtc adapter

Extends go2rtc **1.9.14**, commit `b5948cfb25404cc5cb37b166ecaa2dca20b11d4b`, under the included [MIT license](LICENSE).

## Build and run

The Dockerfile pins upstream sources and builder/runtime images, applies `runtime.patch` and `overlay/`, and builds with upstream Go dependencies.

- `bun run dev --mode docker` builds and runs the Compose service.
- `bun run dev --mode native` exports a native binary for macOS/Linux arm64/x64.

Both modes require Docker and share `config/go2rtc/go2rtc.yaml`. The launcher manages mode switching; use `bun run stop` to stop managed applications and dependencies. Network setup, local ports and platform limitations are documented in [local operation](../../docs/running.md).

## Adapter responsibilities

This adapter is a Go extension compiled into go2rtc, not a separate service. The TypeScript backend owns saved Xiaomi authorization, device inventory and media lifecycle coordination. It sends control requests and SDP to this adapter; video packets travel from cameras through go2rtc to browsers without passing through the backend.

Each camera channel has a private stream shared by a resident consumer and independent WebRTC viewers. The resident consumer keeps capture running and tracks packet activity without decoding or storing video. Closing a viewer removes only its subscription. Private streams exist only in memory, outside the global stream registry and YAML configuration. Runtime-session teardown releases this adapter's media without changing user-configured streams.

For a camera declared with `channelCount: 2`, the two channel streams share one physical MISS connection scoped to the runtime account, device and address. The backend derives channel inventory from the pinned Xiaomi capability catalog; Go has no model-name branch and rejects unsupported channel counts. A single video-start command enables both lenses using the existing go2rtc quality selection; the high byte of packet `flags` selects the lens. Codecs and packet queues stay separate. Dialing and reconnection are serialized per device; a stalled channel consumer cannot block the other lens. Removing one channel leaves the shared connection available; removing the last channel or retiring the account closes it. This is per-process sharing, so another development instance still consumes a separate device connection.

The backend establishes a go2rtc runtime session identified by `sessionId`, then sends heartbeats every 15 seconds to renew its 60-second lease. go2rtc checks expiry every 5 seconds. Expiry clears runtime credentials and owned media, not the encrypted Xiaomi authorization stored by the backend. This lease is distinct from Xiaomi cloud-account session renewal. Camera recovery and viewer cleanup operate independently per channel. No recording, transcoding or model inference is performed here.

`sourceId` identifies a private camera-channel stream; `playbackId` identifies a viewer. The backend's media-generation `revision` rejects stale browser playback requests and is not sent to this internal API. It is unrelated to go2rtc's build revision. See the [resource definitions and lifecycle](../../docs/mijia.md#组件与资源).

Within `overlay/internal/xiaomi/`:

- `home_agent.go`: HTTP boundary, go2rtc runtime session and lease.
- `home_agent_camera.go`: private camera-channel streams, resident consumers and capture recovery.
- `home_agent_dual_camera.go`: dual-camera shared-connection ownership and per-channel private dialers.
- `home_agent_playback.go`: viewer negotiation and retirement.

## Internal API

The base path is `/api/home-agent/mijia/`. Requests require `X-Home-Agent: mijia`, JSON bodies and a loopback/private-network peer; browser Origin and Fetch Metadata are rejected. This is a trusted local management interface, without multi-user authentication. Managed listeners bind to loopback.

| Method and path   | Request                                                                       | Result                                                                                |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PUT session`     | `sessionId`, `userId`, `passToken`, `region: "cn"`                            | Import and validate credentials, after closing old media and clearing its cloud cache |
| `DELETE session`  | `sessionId`                                                                   | Close and erase this session; mismatched IDs cannot affect a new session              |
| `DELETE session`  | `reset: true`                                                                 | Backend startup cleanup of residual Home-Agent state                                  |
| `POST heartbeat`  | `sessionId`                                                                   | Renew the 60-second session lease and return `playbackIds`                            |
| `PUT camera`      | `sessionId`, `sourceId`, `did`, `channel`, `channelCount`, `model`, `localip` | Prepare a shared camera-channel stream and its resident consumer                      |
| `POST playback`   | `sessionId`, `sourceId`, `playbackId`, `offer`                                | Return only `playbackId` and SDP `answer`                                             |
| `DELETE playback` | `sessionId`, `sourceId`, `playbackId`                                         | Close the owned subscription                                                          |

`DELETE camera` accepts `sessionId` and `sourceId` to release a source removed from inventory. A successful `PUT camera` registers the stream and starts asynchronous capture; it does not wait for the first video packet. A successful `POST playback` completes SDP negotiation, not browser frame presentation. Runtime-session and camera mutations return HTTP 204; heartbeat and playback return JSON. Failures use static error codes. The backend coordinates session ownership and viewer reservations.

## Upstream changes

`runtime.patch` and the overlay add the private session/media API, bounded camera negotiation, stream recovery and CS2 packet handling fixes. They also remove sensitive Xiaomi protocol and media logs. Diagnostics expose fixed stage/reason labels rather than device identifiers, addresses or payloads.

The MISS control-message drain includes the focused change from upstream [PR #2489](https://github.com/AlexxIT/go2rtc/pull/2489), commit [`3fd320ec0dd9cd4c90ac9e9bd9115f7637a350c8`](https://github.com/AlexxIT/go2rtc/commit/3fd320ec0dd9cd4c90ac9e9bd9115f7637a350c8).

`overlay/pkg/xiaomi/miss/dual_camera.go` implements the MISS dual-lens transport. The dual-start command and channel-demultiplexing work in upstream [PR #2027](https://github.com/AlexxIT/go2rtc/pull/2027) informed the protocol investigation; this implementation uses the channel flags verified on C500, without resolution or sequence-number guessing. It does not cache credentials across runtime accounts.

Camera compatibility depends on upstream Xiaomi support and backend channel mapping. See [camera usage and limitations](../../docs/mijia.md).
