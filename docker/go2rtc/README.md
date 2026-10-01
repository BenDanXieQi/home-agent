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

For a camera declared with `channelCount: 2`, the two channel streams share one physical MISS connection scoped to the runtime account, device and address. The backend derives channel inventory from the pinned Xiaomi capability catalog; Go has no model-name branch and rejects unsupported channel counts. A single video-start command enables both lenses using the existing go2rtc quality selection; the high byte of packet `flags` selects the lens. Video codecs and packet queues stay separate; the source probes and distributes its shared PCMA or Opus track to audio subscribers. Dialing and reconnection are serialized per device; a stalled channel consumer cannot block the other lens. Removing one channel leaves the shared connection available; removing the last channel or retiring the account closes it. This is per-process sharing, so another development instance still consumes a separate device connection.

The backend establishes a go2rtc runtime session identified by `sessionId`, then sends heartbeats every 15 seconds to renew its 60-second lease. go2rtc checks expiry every 5 seconds. Expiry clears runtime credentials and owned media, not the encrypted Xiaomi authorization stored by the backend. This lease is distinct from Xiaomi cloud-account session renewal. Camera recovery and viewer cleanup operate independently per channel. No recording, transcoding or model inference is performed here. Frame-identified viewing uses the ordinary WebRTC video track and browser frame metadata, as described below.

`sourceId` identifies a private camera-channel stream; `playbackId` identifies a viewer. The backend's media-generation `revision` rejects stale browser playback requests and is not sent to this internal API. It is unrelated to go2rtc's build revision. See the [resource definitions and lifecycle](../../docs/mijia.md#组件与资源).

Within `overlay/internal/xiaomi/`:

- `home_agent.go`: HTTP boundary, go2rtc runtime session and lease.
- `home_agent_audio.go`: request-owned, bounded audio readers; PCMA passthrough and Pion Opus/Ogg packaging with decoded-sample granule timing.
- `home_agent_analysis.go`: request-owned, bounded MPEG-TS analysis consumers for H264/H265 video.
- `home_agent_camera.go`: private camera-channel streams, resident consumers and capture recovery.
- `home_agent_dual_camera.go`: dual-camera shared-connection ownership and per-channel private dialers.
- `home_agent_playback.go`: viewer negotiation and retirement.
- `home_agent_playback_timing.go`: viewer timing snapshots and correlated diagnostics.

## Internal API

The base path is `/api/home-agent/mijia/`. Requests require `X-Home-Agent: mijia`, JSON bodies and a loopback/private-network peer; browser Origin and Fetch Metadata are rejected. This is a trusted local management interface, without multi-user authentication. Managed listeners bind to loopback.

| Method and path   | Request                                                                       | Result                                                                                |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PUT session`     | `sessionId`, `userId`, `passToken`, `region: "cn"`                            | Import and validate credentials, after closing old media and clearing its cloud cache |
| `DELETE session`  | `sessionId`                                                                   | Close and erase this session; mismatched IDs cannot affect a new session              |
| `DELETE session`  | `reset: true`                                                                 | Backend startup cleanup of residual Home-Agent state                                  |
| `POST heartbeat`  | `sessionId`                                                                   | Renew the 60-second session lease and return `playbackIds`                            |
| `PUT camera`      | `sessionId`, `sourceId`, `did`, `channel`, `channelCount`, `model`, `localip` | Prepare a shared camera-channel stream and its resident consumer                      |
| `POST audio`      | `sessionId`, `sourceId`                                                       | Streaming encoded audio; cancellation retires only this audio consumer                |
| `POST analysis`   | `sessionId`, `sourceId`                                                       | Streaming `video/mp2t`; cancellation retires only this analysis consumer              |
| `POST playback`   | `sessionId`, `sourceId`, `playbackId`, `offer`                                | Return `playbackId`, SDP `answer`, `telemetry` and `media`                            |
| `DELETE playback` | `sessionId`, `sourceId`, `playbackId`                                         | Close the owned subscription                                                          |

`DELETE camera` accepts `sessionId` and `sourceId` to release a source removed from inventory. A successful `PUT camera` registers the stream and starts asynchronous capture; it does not wait for the first video packet. A successful `POST playback` completes SDP negotiation, not browser frame presentation. Runtime-session and camera mutations return HTTP 204; heartbeat and playback return JSON. Failures use static error codes. The backend coordinates session ownership and viewer reservations.

Analysis consumers share the existing camera stream and session lease. They are removed when the request, camera, internal channel generation, or session ends. Each camera admits at most four analysis readers. A reader queues at most 32 media chunks or 4 MiB, copies muxer-owned output before queuing, and has a five-second HTTP write deadline. Overflow ends the reader without blocking preview or another lens. Streaming and consumer attachment never hold the global session lock. Backend FFmpeg performs decoding on its host; no new public URL, persistent analysis ID, heartbeat, or DELETE operation is introduced.

Audio readers attach only to the source's actual PCMA/Opus track. They do not wait for video packets. Each camera admits at most two readers, with at most 64 chunks or 256 KiB per reader, a 90-second first-packet deadline, a 30-second silence deadline and a five-second write deadline. Overflow or encoded packet discontinuity ends only the reader; it cannot silently splice input across a VAD continuity gap. Source replacement and session/camera retirement end audio readers independently of video timestamp resets. Invalid audio durations are dropped by the single/dual MISS adapter without restarting healthy video. Audio readers detect the resulting sequence gap or silence and reset independently. RTP sequence and sample-clock continuity are checked with unsigned wraparound. Opus duration comes from `github.com/bluenviron/mediacommon/v2/pkg/codecs/opus` v2.4.3 (MIT), pinned with checksums in `runtime.patch`; single and dual camera adapters share this conversion instead of assuming 40 ms packets.

`POST audio` returns `application/octet-stream`, `X-Audio-Format: alaw|ogg`, a request generation in `X-Audio-Generation`, the host's first audio reception time in `X-Audio-Received-At`, and `X-Audio-Start-Offset-Ms` for samples skipped by the decoder (0 for PCMA, 80 for Opus). Pion WebRTC `v4.2.16` is pinned in `runtime.patch`: its Ogg writer counts actual Opus samples from the first packet and writes a fixed 3840-sample pre-skip. The backend adds that 80 ms to the first decoded sample instead of rebasing it onto the reception anchor. This anchor has unknown synchronization accuracy; it is not a camera capture timestamp. A connected source with no matching track returns `audio_track_missing`; connection failure returns `camera_unavailable`. After video discovery, the one-second audio grace period is checked as media packets arrive; it does not expire the transport socket. Real transport errors still fail the probe. A missing audio track therefore does not terminate a healthy video reader. Backend deduplicates capture and analysis by device, so dual-camera channel observations reference one audio run. No decoding, resampling or VAD is performed in Go.

Playback telemetry contains `stage`, `elapsedMs`, `sourceRecentlyActive` and `timings`. Stages are `queued` (waiting for the camera gate), `connecting` (validating the offer and attaching the source), `signaling` (creating the answer and gathering connection candidates), and `answer_ready` (answer preparation complete). This final stage does not assert that the browser's WebRTC transport is connected or a frame is visible. `elapsedMs` uses the process's monotonic clock, starts when go2rtc accepts the viewer, and stops when answer preparation completes or negotiation fails. `sourceRecentlyActive` records whether the current resident attachment had received a video packet in the preceding 30 seconds when this viewer started; registering a stream alone does not count as packet activity. Optional `timings.queueMs`, `sourceMs` and `answerMs` appear as the gate wait, source attachment, and answer preparation finish. A successful offer has all three timings. These measurements exclude browser setup, network transit and first-frame presentation; the backend and browser record those separately. Telemetry is returned with the offer response and written to negotiation diagnostics; there is no separate playback-status request.

Diagnostics report negotiation outcomes with their timing snapshot, resident attachment duration, and the duration until each resident attachment's first video packet. Viewer negotiation records contain `attempt_id`, the first 16 lowercase hexadecimal characters of SHA-256 over the UTF-8 `playbackId`, matching the backend's correlation key. Logs do not include the resource ID, SDP, device identifiers, addresses or credentials. The adapter does not predict remaining time; each browser derives estimates from its own local playback history. The backend includes connection measurements in the accepted answer; first-frame timing and historical estimates stay in the browser.

## Upstream changes

`runtime.patch` and the overlay add the private session/media API, bounded camera negotiation, stream recovery and CS2 packet handling fixes. They also remove sensitive Xiaomi protocol and media logs. Diagnostics expose fixed stage/reason labels rather than device identifiers, addresses or payloads.

The MISS control-message drain includes the focused change from upstream [PR #2489](https://github.com/AlexxIT/go2rtc/pull/2489), commit [`3fd320ec0dd9cd4c90ac9e9bd9115f7637a350c8`](https://github.com/AlexxIT/go2rtc/commit/3fd320ec0dd9cd4c90ac9e9bd9115f7637a350c8).

`overlay/pkg/xiaomi/miss/dual_camera.go` implements the MISS dual-lens transport. The dual-start command and channel-demultiplexing work in upstream [PR #2027](https://github.com/AlexxIT/go2rtc/pull/2027) informed the protocol investigation; this implementation uses the channel flags verified on C500, without resolution or sequence-number guessing. It does not cache credentials across runtime accounts.

Camera compatibility depends on upstream Xiaomi support and backend channel mapping. See [camera usage and limitations](../../docs/mijia.md).

## Frame-identified continuous viewing

Each physical producer attachment owns a media-generation UUID. Producer replacement, a backward source timestamp and uint32 RTP wrap retire current analysis readers and viewers before forwarding packets in the new generation. `media` in a playback answer contains `generation` and `clockRate: 90000`; analysis response headers carry the same values as `X-Media-Generation` and `X-Media-Clock-Rate`. The analysis MPEG-TS branch retains go2rtc's reader-relative PTS. Before sending headers it obtains the first complete encoded frame and publishes its source RTP timestamp as `X-Media-PTS-Origin`; the backend adds that origin to each decoded NUT PTS. The muxer receives a local input clock beginning at one to keep its zero-value sentinel distinct from source tick zero, while its output still begins at zero. Reader-relative rebasing was introduced by the upstream [MPEG-TS compatibility change](https://github.com/AlexxIT/go2rtc/commit/2ffd859f0e7b1a8c7e507b36a879734a014a99a1); ordinary muxer behavior remains intact. These are source media times, not authenticated wall-clock capture times.

Viewers use the ordinary WebRTC video track. The browser reads decoded frames and their original RTP timestamps through `MediaStreamTrackProcessor` and `VideoFrame.metadata().rtpTimestamp`; go2rtc does not provide a second frame transport. Browser display, freeze ownership and bounds are documented in the [Web README](../../apps/web/README.md#单路感知帧查看).
