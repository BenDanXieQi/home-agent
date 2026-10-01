package xiaomi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/bluenviron/mediacommon/v2/pkg/codecs/opus"
	"github.com/google/uuid"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

// Audio has its own request, liveness and bounded queue; it never waits for video.
type homeAgentAudioConsumer struct {
	core.Connection
	cancel        context.CancelFunc
	packets       chan []byte
	first         chan time.Time
	mu            sync.Mutex
	bytes         int
	format        string
	startOffsetMs int
}

func (c *homeAgentAudioConsumer) Write(data []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.bytes+len(data) > 256*1024 {
		c.cancel()
		return 0, errors.New("audio_overflow")
	}
	select {
	case c.packets <- append([]byte(nil), data...):
		c.bytes += len(data)
		return len(data), nil
	default:
		c.cancel()
		return 0, errors.New("audio_overflow")
	}
}

func (c *homeAgentAudioConsumer) AddTrack(media *core.Media, _ *core.Codec, track *core.Receiver) error {
	sender := core.NewSender(media, track.Codec)
	var write func(*rtp.Packet) error
	switch track.Codec.Name {
	case core.CodecPCMA:
		if track.Codec.ClockRate != 8000 {
			return errors.New("unsupported_audio_codec")
		}
		c.format = "alaw"
		write = func(packet *rtp.Packet) error { _, err := c.Write(packet.Payload); return err }
	case core.CodecOpus:
		c.format = "ogg"
		writer, err := oggwriter.NewWith(c, uint32(track.Codec.ClockRate), uint16(max(1, track.Codec.Channels)))
		if err != nil {
			return err
		}
		// Pion v4.2.16 counts decoded samples, including the first packet.
		// Its fixed 3840-sample Opus pre-skip advances decoded media by 80 ms.
		c.startOffsetMs = 80
		write = writer.WriteRTP
	default:
		return errors.New("unsupported_audio_codec")
	}
	seen := false
	var previous uint16
	var nextTimestamp uint32
	sender.Output = func(packet *rtp.Packet) {
		if seen && (packet.SequenceNumber != previous+1 || packet.Timestamp != nextTimestamp) {
			// Missing encoded packets invalidate continuous VAD state. Never splice across a gap.
			c.cancel()
			return
		}
		duration := uint32(len(packet.Payload))
		if track.Codec.Name == core.CodecOpus {
			samples := opus.PacketDuration2(packet.Payload)
			if samples <= 0 || samples > 5760 {
				c.cancel()
				return
			}
			duration = uint32(samples)
		}
		if !seen {
			c.first <- time.Now()
		}
		previous, nextTimestamp, seen = packet.SequenceNumber, packet.Timestamp+duration, true
		if write(packet) != nil {
			c.cancel()
		}
	}
	sender.WithParent(track)
	sender.Start()
	c.Senders = append(c.Senders, sender)
	return nil
}

func homeAgentAudio(w http.ResponseWriter, r *http.Request) {
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
	if camera == nil || len(camera.audioAnalyses) >= 2 {
		homeAgentMu.Unlock()
		homeAgentError(w, "camera_not_found", 409)
		return
	}
	ctx, cancel := context.WithCancel(camera.ctx)
	consumer := &homeAgentAudioConsumer{
		Connection: core.Connection{ID: core.NewID(), FormatName: "home-agent/audio", Medias: []*core.Media{{Kind: core.KindAudio, Direction: core.DirectionSendonly, Codecs: []*core.Codec{{Name: core.CodecPCMA}, {Name: core.CodecOpus}}}}},
		cancel:     cancel, packets: make(chan []byte, 64), first: make(chan time.Time, 1),
	}
	camera.audioAnalyses[consumer] = cancel
	homeAgentMu.Unlock()
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()
	defer func() {
		homeAgentMu.Lock()
		delete(camera.audioAnalyses, consumer)
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
		if strings.HasPrefix(err.Error(), "streams: codecs not matched:") {
			homeAgentError(w, "audio_track_missing", 422)
		} else {
			homeAgentError(w, "camera_unavailable", 502)
		}
		return
	}
	if len(consumer.Senders) == 0 {
		homeAgentError(w, "audio_track_missing", 422)
		return
	}
	firstDeadline := time.NewTimer(homeAgentFirstPacketTimeout)
	defer firstDeadline.Stop()
	var first time.Time
	select {
	case first = <-consumer.first:
	case <-firstDeadline.C:
		homeAgentError(w, "audio_packet_timeout", 504)
		return
	case <-ctx.Done():
		return
	}
	controller := http.NewResponseController(w)
	stopWrite := context.AfterFunc(ctx, func() { _ = controller.SetWriteDeadline(time.Now()) })
	defer stopWrite()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Audio-Format", consumer.format)
	w.Header().Set("X-Audio-Generation", uuid.NewString())
	w.Header().Set("X-Audio-Received-At", strconv.FormatInt(first.UnixMilli(), 10))
	w.Header().Set("X-Audio-Start-Offset-Ms", strconv.Itoa(consumer.startOffsetMs))
	silence := time.NewTimer(homeAgentPacketSilence)
	defer silence.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-silence.C:
			return
		case data := <-consumer.packets:
			if ctx.Err() != nil {
				return
			}
			consumer.mu.Lock()
			consumer.bytes -= len(data)
			consumer.mu.Unlock()
			if controller.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
				return
			}
			if _, err := w.Write(data); err != nil {
				return
			}
			if controller.Flush() != nil {
				return
			}
			if !silence.Stop() {
				select {
				case <-silence.C:
				default:
				}
			}
			silence.Reset(homeAgentPacketSilence)
		}
	}
}
