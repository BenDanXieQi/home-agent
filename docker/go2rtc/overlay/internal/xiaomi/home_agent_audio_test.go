package xiaomi

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/pion/rtp"
)

// A source alternates 20/40 ms Opus silence. Its 1.2 s timeline must survive
// our real consumer and a real decoder, including the discarded initial audio.
func TestAudioTimelineSurvivesOpusPackaging(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := &homeAgentAudioConsumer{cancel: cancel, packets: make(chan []byte, 64), first: make(chan time.Time, 1)}
	codec := &core.Codec{Name: core.CodecOpus, ClockRate: 48000, Channels: 1}
	media := &core.Media{Kind: core.KindAudio, Direction: core.DirectionSendonly, Codecs: []*core.Codec{codec}}
	receiver := core.NewReceiver(media, codec)
	if err := c.AddTrack(media, codec, receiver); err != nil {
		t.Fatal(err)
	}
	defer c.Stop()
	finished := make(chan struct{})
	handler := c.Senders[0].Output
	c.Senders[0].Output = func(packet *rtp.Packet) {
		handler(packet)
		if packet.SequenceNumber == 39 {
			close(finished)
		}
	}
	var timestamp uint32
	for index := range 40 {
		payload := []byte{0xf8, 0xff, 0xfe}
		samples := uint32(960)
		if index%2 != 0 {
			payload = []byte{0xf9, 0xff, 0xfe, 0xff, 0xfe}
			samples = 1920
		}
		receiver.Input(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(index), Timestamp: timestamp}, Payload: payload})
		timestamp += samples
	}
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("audio was cancelled or did not finish")
	}
	var encoded bytes.Buffer
	for len(c.packets) > 0 {
		encoded.Write(<-c.packets)
	}
	if path := os.Getenv("P3_OPUS_FIXTURE_OUT"); path != "" {
		if err := os.WriteFile(path, encoded.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
	}
	command := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1")
	command.Stdin = bytes.NewReader(encoded.Bytes())
	pcm, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	durationMs := len(pcm) * 1000 / (16000 * 2)
	if durationMs+c.startOffsetMs != 1200 {
		t.Fatalf("source duration 1200 ms became decoded %d + skipped %d ms", durationMs, c.startOffsetMs)
	}
}
