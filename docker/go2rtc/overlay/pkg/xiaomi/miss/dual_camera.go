package miss

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/h264"
	"github.com/AlexxIT/go2rtc/pkg/h264/annexb"
	"github.com/AlexxIT/go2rtc/pkg/h265"
	"github.com/AlexxIT/go2rtc/pkg/xiaomi/diagnostic"
	"github.com/pion/rtp"
)

// DualCamera owns one physical MISS connection for a declared two-lens camera
// in one account session. Lens inventory is supplied by Xiaomi camera metadata.
// Each channel exposes its own producer, codecs and viewer lifetime.
type DualCamera struct {
	ctx        context.Context
	cancel     context.CancelFunc
	resolveURL func() (string, error)
	mu         sync.Mutex
	current    atomic.Pointer[dualSession]
}

func NewDualCamera(resolveURL func() (string, error)) *DualCamera {
	ctx, cancel := context.WithCancel(context.Background())
	return &DualCamera{ctx: ctx, cancel: cancel, resolveURL: resolveURL}
}

func (c *DualCamera) Close() {
	c.cancel()
	if session := c.current.Load(); session != nil {
		session.close()
	}
}

func (c *DualCamera) Open(channel int) (core.Producer, error) {
	if channel < 1 || channel > 2 {
		return nil, errors.New("xiaomi: invalid channel")
	}
	// Serialize initialization, including cloud key exchange. Parallel channels
	// must never open competing camera connections before choosing a winner.
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ctx.Err() != nil {
		return nil, c.ctx.Err()
	}
	session := c.current.Load()
	if session == nil || session.closed() {
		rawURL, err := c.resolveURL()
		if err != nil {
			diagnostic.Report("dual_cloud_lookup", err)
			return nil, err
		}
		if c.ctx.Err() != nil {
			return nil, c.ctx.Err()
		}
		client, err := NewClient(rawURL)
		if err != nil {
			return nil, err
		}
		session = &dualSession{client: client, done: make(chan struct{}), readers: make(map[*dualProducer]struct{})}
		c.current.Store(session)
		if c.ctx.Err() != nil {
			session.close()
			return nil, c.ctx.Err()
		}
		stop := context.AfterFunc(c.ctx, session.close)
		err = session.prepare()
		if err != nil {
			session.close()
			stop()
			diagnostic.Report("dual_camera_probe", err)
			return nil, err
		}
		diagnostic.Report("dual_camera_session", nil)
		go func() { defer stop(); session.run() }()
	}
	return session.producer(channel - 1), nil
}

type dualSession struct {
	client    *Client
	codecs    [2]*core.Codec
	audio     *core.Codec
	done      chan struct{}
	closeOnce sync.Once
	stopping  atomic.Bool
	mu        sync.Mutex
	readers   map[*dualProducer]struct{}
}

func (s *dualSession) closed() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

func (s *dualSession) close() {
	s.closeOnce.Do(func() {
		s.stopping.Store(true)
		// Closing the transport wakes command/media readers even during a probe.
		_ = s.client.Close()
		close(s.done)
	})
}

func (s *dualSession) prepare() error {
	data := binary.BigEndian.AppendUint32(nil, cmdVideoStart)
	quality := s.client.videoQuality("")
	data = fmt.Appendf(data, `{"videoquality":%s,"videoquality2":%s,"enableaudio":1}`, quality, quality)
	if err := s.client.WriteCommand(data); err != nil {
		return err
	}
	_ = s.client.SetDeadline(time.Now().Add(15 * time.Second))
	var audioDeadline time.Time
	for {
		packet, err := s.client.ReadPacket()
		if err != nil {
			return err
		}
		if packet.CodecID == codecPCMA {
			s.audio = &core.Codec{Name: core.CodecPCMA, ClockRate: 8000}
		}
		if packet.CodecID == codecOPUS {
			s.audio = &core.Codec{Name: core.CodecOpus, ClockRate: 48000, Channels: 2}
		}
		if s.codecs[0] != nil && s.codecs[1] != nil && (s.audio != nil || !time.Now().Before(audioDeadline)) {
			break
		}
		if packet.CodecID != codecH264 && packet.CodecID != codecH265 {
			continue
		}
		channel := int(packet.Flags >> 24)
		if channel > 1 {
			return errors.New("xiaomi: invalid dual channel")
		}
		if s.codecs[channel] != nil {
			continue
		}
		avcc := annexb.EncodeToAVCC(packet.Payload)
		if packet.CodecID == codecH264 && h264.NALUType(avcc) == h264.NALUTypeSPS {
			s.codecs[channel] = h264.AVCCToCodec(avcc)
		} else if packet.CodecID == codecH265 && h265.NALUType(avcc) == h265.NALUTypeVPS {
			s.codecs[channel] = h265.AVCCToCodec(avcc)
		}
		if s.codecs[0] != nil && s.codecs[1] != nil {
			if s.audio != nil {
				break
			}
			// A probe deadline is not a transport timeout: the video reader must remain alive.
			audioDeadline = time.Now().Add(time.Second)
		}
	}
	return nil
}

func (s *dualSession) producer(channel int) *dualProducer {
	codec := s.codecs[channel]
	medias := []*core.Media{{Kind: core.KindVideo, Direction: core.DirectionRecvonly, Codecs: []*core.Codec{codec}}}
	if s.audio != nil {
		medias = append(medias, &core.Media{Kind: core.KindAudio, Direction: core.DirectionRecvonly, Codecs: []*core.Codec{s.audio}})
	}
	return &dualProducer{
		Connection: core.Connection{ID: core.NewID(), FormatName: "xiaomi/miss", Protocol: s.client.Protocol(),
			Medias: medias},
		session: s, channel: channel, packets: make(chan *Packet, 100), done: make(chan struct{}),
	}
}

func (s *dualSession) run() {
	defer s.close()
	for {
		_ = s.client.SetDeadline(time.Now().Add(10 * time.Second))
		packet, err := s.client.ReadPacket()
		if err != nil {
			if !s.stopping.Load() {
				diagnostic.Report("dual_camera_read", err)
			}
			return
		}
		audio := packet.CodecID == codecPCMA || packet.CodecID == codecOPUS
		if !audio && packet.CodecID != codecH264 && packet.CodecID != codecH265 {
			continue
		}
		// MISS encodes the lens index in the flags high byte. This was verified
		// on the local dual camera and independently documented for another
		// Xiaomi dual-lens device in go2rtc PR #2027; do not infer from resolution.
		channel := int(packet.Flags >> 24)
		if !audio && channel > 1 {
			diagnostic.Report("dual_camera_channel", errors.New("invalid channel"))
			return
		}
		s.mu.Lock()
		for reader := range s.readers {
			if !audio && reader.channel != channel {
				continue
			}
			select {
			case reader.packets <- packet:
			default:
				// A slow viewer must not stall the other lens or accumulate frames.
				reader.finish()
				delete(s.readers, reader)
			}
		}
		s.mu.Unlock()
	}
}

type dualProducer struct {
	core.Connection
	session *dualSession
	channel int
	packets chan *Packet
	done    chan struct{}
	once    sync.Once
}

func (p *dualProducer) finish() { p.once.Do(func() { close(p.done) }) }

func (p *dualProducer) Start() error {
	var audioTS uint32
	p.session.mu.Lock()
	p.session.readers[p] = struct{}{}
	p.session.mu.Unlock()
	defer func() { p.session.mu.Lock(); delete(p.session.readers, p); p.session.mu.Unlock() }()
	for {
		select {
		case <-p.done:
			return io.EOF
		case <-p.session.done:
			return io.EOF
		case packet := <-p.packets:
			p.Recv += len(packet.Payload)
			raw := &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(packet.Sequence), Timestamp: TimeToRTP(packet.Timestamp, 90000)}, Payload: packet.Payload}
			if packet.CodecID == codecH264 || packet.CodecID == codecH265 {
				raw.Payload = annexb.EncodeToAVCC(packet.Payload)
			}
			name := core.CodecH264
			if packet.CodecID == codecH265 {
				name = core.CodecH265
			}
			if packet.CodecID == codecPCMA || packet.CodecID == codecOPUS {
				name = core.CodecPCMA
				raw.Payload = packet.Payload
				raw.Timestamp = audioTS
				raw.Version = 2
				if packet.CodecID == codecOPUS {
					name = core.CodecOpus
				}
				samples, err := audioSamples(packet)
				if err != nil {
					// Drop only invalid audio. The sequence gap resets continuous
					// audio readers without reconnecting either video lens.
					continue
				}
				audioTS += samples
			}
			for _, receiver := range p.Receivers {
				if receiver.Codec.Name == name {
					receiver.WriteRTP(raw)
				}
			}
		}
	}
}

func (p *dualProducer) Stop() error {
	p.finish()
	return p.Connection.Stop()
}
