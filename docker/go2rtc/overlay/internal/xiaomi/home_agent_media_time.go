package xiaomi

import (
	"sync"
	"sync/atomic"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/google/uuid"
	"github.com/pion/rtp"
)

// Each physical producer attachment has one media generation. Reset and wrap
// retire its readers before the first packet with reused timestamps is forwarded.
type homeAgentMediaTime struct {
	Generation string `json:"generation"`
	ClockRate  int    `json:"clockRate"`
	mu         sync.Mutex
	last       uint32
	seen       bool
}

type homeAgentTimedProducer struct {
	core.Producer
	camera   *homeAgentCameraState
	timeline atomic.Pointer[homeAgentMediaTime]
	tracksMu sync.Mutex
	tracks   map[*core.Receiver]bool
}

func homeAgentTimeProducer(camera *homeAgentCameraState, producer core.Producer) core.Producer {
	timeline := &homeAgentMediaTime{Generation: uuid.NewString(), ClockRate: 90000}
	homeAgentMu.Lock()
	previous := camera.timeline.Swap(timeline)
	if previous != nil {
		homeAgentRetireMedia(camera)
		for _, cancel := range camera.audioAnalyses {
			cancel()
		}
	}
	homeAgentMu.Unlock()
	p := &homeAgentTimedProducer{Producer: producer, camera: camera, tracks: make(map[*core.Receiver]bool)}
	p.timeline.Store(timeline)
	return p
}

// Caller holds homeAgentMu. It never waits for stream attachment or network IO.
func homeAgentRetireMedia(camera *homeAgentCameraState) {
	for _, cancel := range camera.analyses {
		cancel()
	}
	for _, playback := range camera.playbacks {
		playback.cancel()
	}
}

func (p *homeAgentTimedProducer) GetTrack(media *core.Media, codec *core.Codec) (*core.Receiver, error) {
	track, err := p.Producer.GetTrack(media, codec)
	if err != nil || media.Kind != core.KindVideo {
		return track, err
	}
	p.tracksMu.Lock()
	defer p.tracksMu.Unlock()
	if p.tracks[track] {
		return track, nil
	}
	if track.Codec.ClockRate != 90000 {
		return nil, core.ErrCantGetTrack
	}
	p.tracks[track] = true
	input := track.Input
	track.Input = func(packet *rtp.Packet) {
		timeline := p.timeline.Load()
		if p.camera.timeline.Load() != timeline {
			return
		}
		timeline.mu.Lock()
		changed := timeline.seen && packet.Timestamp < timeline.last
		if changed {
			// Includes uint32 wrap. Each branch uses the same source generation
			// rather than independently reconstructing an earlier clock cycle.
			homeAgentMu.Lock()
			if p.camera.timeline.Load() != timeline {
				homeAgentMu.Unlock()
				timeline.mu.Unlock()
				return
			}
			replacement := &homeAgentMediaTime{Generation: uuid.NewString(), ClockRate: 90000,
				last: packet.Timestamp, seen: true}
			p.camera.timeline.Store(replacement)
			p.timeline.Store(replacement)
			homeAgentRetireMedia(p.camera)
			homeAgentMu.Unlock()
		}
		timeline.seen = true
		timeline.last = packet.Timestamp
		timeline.mu.Unlock()
		input(packet)
	}
	return track, nil
}

func (p *homeAgentTimedProducer) retireTimeline() {
	homeAgentMu.Lock()
	defer homeAgentMu.Unlock()
	if p.camera.timeline.CompareAndSwap(p.timeline.Load(), nil) {
		homeAgentRetireMedia(p.camera)
	}
}

func (p *homeAgentTimedProducer) Start() error {
	defer p.retireTimeline()
	return p.Producer.Start()
}

func (p *homeAgentTimedProducer) Stop() error {
	p.retireTimeline()
	return p.Producer.Stop()
}

func homeAgentMediaGeneration(camera *homeAgentCameraState) string {
	if timeline := camera.timeline.Load(); timeline != nil {
		return timeline.Generation
	}
	return ""
}
