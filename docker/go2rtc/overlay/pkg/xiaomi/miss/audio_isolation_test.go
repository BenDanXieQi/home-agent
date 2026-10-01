package miss

import (
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
)

func TestMalformedAudioDoesNotInterruptVideo(t *testing.T) {
	session := &dualSession{readers: make(map[*dualProducer]struct{}), done: make(chan struct{})}
	producer := &dualProducer{session: session, packets: make(chan *Packet, 2), done: make(chan struct{})}
	delivered := make(chan struct{}, 1)
	receiver := core.NewReceiver(&core.Media{Kind: core.KindVideo}, &core.Codec{Name: core.CodecH264})
	receiver.Input = func(_ *core.Packet) { delivered <- struct{}{} }
	producer.Receivers = append(producer.Receivers, receiver)
	exited := make(chan error, 1)
	go func() { exited <- producer.Start() }()
	defer func() { producer.finish(); <-exited }()
	producer.packets <- &Packet{CodecID: codecOPUS, Payload: nil}
	producer.packets <- &Packet{CodecID: codecH264, Payload: []byte{0, 0, 0, 1, 0x65, 1}}
	select {
	case <-delivered:
	case <-time.After(time.Second):
		t.Fatal("healthy video stopped after an invalid audio packet")
	}
}
