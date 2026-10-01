package xiaomi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/h264"
	"github.com/AlexxIT/go2rtc/pkg/h265"
	"github.com/AlexxIT/go2rtc/pkg/mpegts"
	"github.com/pion/rtp"
)

// Request-owned, with no persistent identifier or independent lease.
type homeAgentAnalysisConsumer struct {
	core.Connection
	cancel  context.CancelFunc
	packets chan homeAgentAnalysisPacket
	mu      sync.Mutex
	bytes   int
	muxer   *mpegts.Muxer
}

type homeAgentAnalysisPacket struct {
	payload   []byte
	timestamp uint32
}

func (c *homeAgentAnalysisConsumer) AddTrack(media *core.Media, _ *core.Codec, track *core.Receiver) error {
	var kind byte
	switch track.Codec.Name {
	case core.CodecH264:
		kind = mpegts.StreamTypeH264
	case core.CodecH265:
		kind = mpegts.StreamTypeH265
	default:
		return errors.New("unsupported_analysis_codec")
	}
	pid := c.muxer.AddTrack(kind)
	sender := core.NewSender(media, track.Codec)
	var origin uint32
	anchored := false
	sender.Handler = func(packet *rtp.Packet) {
		if !anchored {
			origin, anchored = packet.Timestamp, true
		}
		// Preserve the muxer's reader-relative PTS. Its previous-timestamp sentinel
		// is zero, so use a reader-local clock starting at one even for source tick zero.
		payload := c.muxer.GetPayload(pid, packet.Timestamp-origin+1, packet.Payload)
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.bytes+len(payload) > 4*1024*1024 {
			c.cancel()
			return
		}
		select {
		case c.packets <- homeAgentAnalysisPacket{append([]byte(nil), payload...), packet.Timestamp}:
			c.bytes += len(payload)
		default:
			c.cancel()
		}
	}
	if track.Codec.Name == core.CodecH264 {
		if track.Codec.IsRTP() {
			sender.Handler = h264.RTPDepay(track.Codec, sender.Handler)
		} else {
			sender.Handler = h264.RepairAVCC(track.Codec, sender.Handler)
		}
	} else if track.Codec.IsRTP() {
		sender.Handler = h265.RTPDepay(track.Codec, sender.Handler)
	}
	sender.HandleRTP(track)
	c.Senders = append(c.Senders, sender)
	return nil
}

func homeAgentAnalysis(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
		SourceID  string `json:"sourceId"`
	}
	if !homeAgentRead(w, r, &body) {
		return
	}
	homeAgentMu.Lock()
	session := homeAgentRequireSession(w, body.SessionID)
	if session == nil {
		homeAgentMu.Unlock()
		return
	}
	camera := session.cameras[body.SourceID]
	if camera == nil || len(camera.analyses) >= 4 {
		homeAgentMu.Unlock()
		homeAgentError(w, "camera_not_found", 409)
		return
	}
	ctx, cancel := context.WithCancel(camera.ctx)
	consumer := &homeAgentAnalysisConsumer{
		Connection: core.Connection{ID: core.NewID(), FormatName: "home-agent/analysis", Medias: []*core.Media{{Kind: core.KindVideo, Direction: core.DirectionSendonly, Codecs: []*core.Codec{{Name: core.CodecH264}, {Name: core.CodecH265}}}}},
		cancel:     cancel, packets: make(chan homeAgentAnalysisPacket, 32), muxer: mpegts.NewMuxer(),
	}
	camera.analyses[consumer] = cancel
	homeAgentMu.Unlock()
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()
	defer func() {
		homeAgentMu.Lock()
		delete(camera.analyses, consumer)
		homeAgentMu.Unlock()
		go func() {
			camera.gate <- struct{}{}
			defer func() { <-camera.gate }()
			camera.stream.RemoveConsumer(consumer)
		}()
	}()
	select {
	case camera.gate <- struct{}{}:
	case <-ctx.Done():
		return
	}
	if ctx.Err() != nil {
		<-camera.gate
		return
	}
	err := camera.stream.AddConsumer(consumer)
	<-camera.gate
	if err != nil {
		homeAgentError(w, "camera_unavailable", 502)
		return
	}
	if ctx.Err() != nil {
		return
	}
	var first homeAgentAnalysisPacket
	select {
	case <-ctx.Done():
		return
	case first = <-consumer.packets:
	}
	controller := http.NewResponseController(w)
	// Cancellation interrupts a blocked network write; it never takes the global lock.
	stopWrite := context.AfterFunc(ctx, func() { _ = controller.SetWriteDeadline(time.Now()) })
	defer stopWrite()
	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("X-Media-Generation", homeAgentMediaGeneration(camera))
	w.Header().Set("X-Media-Clock-Rate", "90000")
	w.Header().Set("X-Media-PTS-Origin", strconv.FormatUint(uint64(first.timestamp), 10))
	write := func(data []byte) bool {
		if ctx.Err() != nil {
			return false
		}
		if controller.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
			return false
		}
		if _, err := w.Write(data); err != nil {
			return false
		}
		return controller.Flush() == nil
	}
	if !write(consumer.muxer.GetHeader()) {
		return
	}
	consumer.mu.Lock()
	consumer.bytes -= len(first.payload)
	consumer.mu.Unlock()
	if !write(first.payload) {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case packet := <-consumer.packets:
			consumer.mu.Lock()
			consumer.bytes -= len(packet.payload)
			consumer.mu.Unlock()
			if !write(packet.payload) {
				return
			}
		}
	}
}
