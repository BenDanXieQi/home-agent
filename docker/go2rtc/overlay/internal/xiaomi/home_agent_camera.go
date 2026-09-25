package xiaomi

import (
	"context"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/AlexxIT/go2rtc/internal/streams"
	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/google/uuid"
	"github.com/pion/rtp"
)

// One private stream per camera channel, shared by its resident consumer and viewers.
type homeAgentCameraState struct {
	stream    *streams.Stream
	ctx       context.Context
	cancel    context.CancelFunc
	gate      chan struct{}
	playbacks map[string]*homeAgentPlaybackState
}

var homeAgentModel = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,128}$`)

const (
	homeAgentFirstPacketTimeout = 90 * time.Second
	homeAgentPacketSilence      = 30 * time.Second
	homeAgentRetryMinimum       = 5 * time.Second
	homeAgentRetryMaximum       = time.Minute
	homeAgentRetryResetAfter    = time.Minute
)

func homeAgentCamera(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
		SourceID  string `json:"sourceId"`

		Did     string `json:"did"`
		Channel int    `json:"channel"`
		Model   string `json:"model"`
		LocalIP string `json:"localip"`
	}
	if !homeAgentRead(w, r, &body) {
		return
	}
	session := homeAgentRequireSession(w, body.SessionID)
	if session == nil {
		return
	}
	if _, err := uuid.Parse(body.SourceID); err != nil {
		homeAgentError(w, "invalid_request", http.StatusBadRequest)
		return
	}
	if session.retired[body.SourceID].After(time.Now()) {
		homeAgentError(w, "stale_playback", http.StatusConflict)
		return
	}
	if camera := session.cameras[body.SourceID]; camera != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(session.cameras) >= 32 {
		homeAgentError(w, "stale_playback", http.StatusConflict)
		return
	}
	ip := net.ParseIP(body.LocalIP)
	if (body.Channel != 1 && body.Channel != 2) || !homeAgentIdentifier.MatchString(body.Did) || !homeAgentModel.MatchString(body.Model) ||
		(!strings.Contains(body.Model, ".camera.") && !strings.Contains(body.Model, ".cateye.")) ||
		ip == nil || !ip.IsPrivate() || ip.To4() == nil {
		homeAgentError(w, "camera_unavailable", http.StatusBadRequest)
		return
	}
	source := url.URL{Scheme: "xiaomi", User: url.UserPassword(session.alias, session.region), Host: body.LocalIP}
	source.RawQuery = url.Values{"did": {body.Did}, "model": {body.Model}, "audio": {"0"}}.Encode()
	if body.Channel == 2 {
		query := source.Query()
		query.Set("channel", "2")
		source.RawQuery = query.Encode()
	}
	// Private streams never enter the global stream registry or configuration.
	ctx, cancel := context.WithCancel(context.Background())
	session.cameras[body.SourceID] = &homeAgentCameraState{
		stream: streams.NewStream(source.String()),
		ctx:    ctx, cancel: cancel, gate: make(chan struct{}, 1),
		playbacks: make(map[string]*homeAgentPlaybackState),
	}
	homeAgentCapture(session, session.cameras[body.SourceID])
	w.WriteHeader(http.StatusNoContent)
}

func homeAgentCloseCamera(camera *homeAgentCameraState) {
	if camera == nil {
		return
	}
	camera.cancel()
	// Close cannot race AddConsumer. Retired cameras finish their own bounded dial
	// and cleanup without blocking heartbeats, DELETE or a new camera's stream.
	go func() {
		camera.gate <- struct{}{}
		defer func() { <-camera.gate }()
		camera.stream.Close()
	}()
}

// A packet-only consumer maintains source ownership without decoding or storing
// video. Liveness uses every packet, independent of keyframe cadence.
type homeAgentPacketActivity struct{ last atomic.Int64 }
type homeAgentSourceConsumer struct {
	core.Connection
	activity *homeAgentPacketActivity
}

func homeAgentNewConsumer(activity *homeAgentPacketActivity) *homeAgentSourceConsumer {
	return &homeAgentSourceConsumer{
		Connection: core.Connection{
			ID: core.NewID(), FormatName: "home-agent/source",
			Medias: []*core.Media{{Kind: core.KindVideo, Direction: core.DirectionSendonly,
				Codecs: []*core.Codec{{Name: core.CodecH264}, {Name: core.CodecH265}}}},
		},
		activity: activity,
	}
}
func (c *homeAgentSourceConsumer) AddTrack(media *core.Media, _ *core.Codec, track *core.Receiver) error {
	sender := core.NewSender(media, track.Codec)
	sender.Handler = func(_ *rtp.Packet) { c.activity.last.Store(time.Now().UnixNano()) }
	sender.HandleRTP(track)
	c.Senders = append(c.Senders, sender)
	return nil
}

// Rebuild the entire channel, including hidden viewers that cannot detect silence.
// Never wait for a camera's gate while holding the session ownership lock.
func homeAgentRestartStalled(session *homeAgentSession, camera *homeAgentCameraState, activity *homeAgentPacketActivity, observed time.Time) bool {
	select {
	case camera.gate <- struct{}{}:
	case <-camera.ctx.Done():
		return true
	}
	defer func() { <-camera.gate }()
	if camera.ctx.Err() != nil {
		return true
	}
	// A viewer dial or native reconnect may have restored the source while this
	// watchdog waited for the gate. Preserve its consumers and reconnect backoff.
	if camera.stream.HomeAgentReconnecting() || time.Unix(0, activity.last.Load()).After(observed) {
		return false
	}
	homeAgentMu.Lock()
	if homeAgentCurrent.Load() != session || camera.ctx.Err() != nil {
		homeAgentMu.Unlock()
		return true
	}
	for _, playback := range camera.playbacks {
		homeAgentRetirePlayback(session, camera, playback)
	}
	homeAgentMu.Unlock()
	// Removing only the resident consumer cannot stop a producer still owned by
	// a browser. Close resets the private producer so the next attachment redials.
	// Viewer cleanup can acquire homeAgentMu, so Close must run outside that lock.
	camera.stream.Close()
	return true
}

// Caller holds homeAgentMu. Source lifetime belongs to the backend session, never a viewer request.
func homeAgentCapture(session *homeAgentSession, camera *homeAgentCameraState) {
	ctx := camera.ctx
	go func() {
		retryDelay := homeAgentRetryMinimum
		for ctx.Err() == nil {
			// A closed sender may still drain buffered packets. Its activity must
			// never count as a first packet from a newer resident attachment.
			activity := &homeAgentPacketActivity{}
			consumer := homeAgentNewConsumer(activity)
			select {
			case camera.gate <- struct{}{}:
			case <-ctx.Done():
				return
			}
			if ctx.Err() != nil {
				<-camera.gate
				return
			}
			attachedAt := time.Now()
			err := camera.stream.AddConsumer(consumer)
			<-camera.gate
			if err == nil {
				lastActivity := attachedAt
				firstPacket := time.Time{}
				ticker := time.NewTicker(10 * time.Second)
			receiving:
				for {
					select {
					case <-ctx.Done():
						break receiving
					case <-ticker.C:
						// The producer already owns retries after an established source
						// fails. Removing its last consumer would reset that backoff.
						if camera.stream.HomeAgentReconnecting() {
							attachedAt = time.Now()
							lastActivity = attachedAt
							firstPacket = time.Time{}
							continue
						}
						if frame := time.Unix(0, activity.last.Load()); frame.After(lastActivity) {
							lastActivity = frame
							if firstPacket.IsZero() {
								firstPacket = frame
							}
						}
						// Repeated attachments without packets must not reset the retry
						// delay. Sustained media, rather than a successful dial, resets it.
						if !firstPacket.IsZero() && lastActivity.Sub(firstPacket) >= homeAgentRetryResetAfter {
							retryDelay = homeAgentRetryMinimum
						}
						timeout := homeAgentPacketSilence
						if firstPacket.IsZero() {
							timeout = homeAgentFirstPacketTimeout
						}
						if time.Since(lastActivity) >= timeout && homeAgentRestartStalled(session, camera, activity, lastActivity) {
							break receiving
						}
					}
				}
				ticker.Stop()
			}
			camera.gate <- struct{}{}
			camera.stream.RemoveConsumer(consumer)
			<-camera.gate
			// Per-source capped backoff avoids repeated failed attachments; jitter
			// keeps cameras that lost connectivity together from redialing together.
			wait := retryDelay - time.Duration(rand.Int64N(int64(retryDelay/4)))
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			retryDelay = min(retryDelay*2, homeAgentRetryMaximum)
		}
	}()
}
