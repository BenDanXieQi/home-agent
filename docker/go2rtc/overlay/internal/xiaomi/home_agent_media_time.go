package xiaomi

import (
	"sync"

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
	timeline *homeAgentMediaTime
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
	return &homeAgentTimedProducer{Producer: producer, camera: camera, timeline: timeline, tracks: make(map[*core.Receiver]bool)}
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
	if err != nil || media.Kind != core.KindVideo || p.tracks[track] {
		return track, err
	}
	if track.Codec.ClockRate != 90000 {
		return nil, core.ErrCantGetTrack
	}
	p.tracks[track] = true
	input := track.Input
	track.Input = func(packet *rtp.Packet) {
		timeline := p.timeline
		if p.camera.timeline.Load() != timeline {
			return
		}
		timeline.mu.Lock()
		if timeline.seen && packet.Timestamp < timeline.last {
			// Includes uint32 wrap. New readers get a new generation, not an
			// ambiguous timestamp correction inferred independently per branch.
			homeAgentMu.Lock()
			replacement := &homeAgentMediaTime{Generation: uuid.NewString(), ClockRate: 90000, last: packet.Timestamp, seen: true}
			p.camera.timeline.Store(replacement)
			p.timeline = replacement
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

func homeAgentMediaGeneration(camera *homeAgentCameraState) string {
	if timeline := camera.timeline.Load(); timeline != nil {
		return timeline.Generation
	}
	return ""
}
