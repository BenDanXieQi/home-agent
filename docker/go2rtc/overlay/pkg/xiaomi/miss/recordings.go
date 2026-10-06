package miss

import (
	"context"
	"encoding/binary"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/xiaomi/crypto"
	"github.com/AlexxIT/go2rtc/pkg/xiaomi/miss/cs2"
)

// Wire evidence: xiaomi-camera-viewer, MIT, commit
// 4dc3ae3a77245c5c9afed1981d9840816a439de7, recordings.go and miss/client.go.
// This adapter reads recording metadata and files from the selected storage channel. It does not send
// playback, recording-setting, deletion or format commands.
const recordingIndexCommand = 6
const recordingMaxEntries = 65536
const recordingIndexBytes = 4 + 8*recordingMaxEntries
const recordingQueryTimeout = 15 * time.Second

// These reference-parser bounds reject stale slots in the fixed-size card
// index. They are index validity limits, not a universal camera date range.
const recordingMinStart = 1577836800 // 2020-01-01
const recordingMaxStart = 2524608000 // 2050-01-01

var ErrRecordingsUnsupported = errors.New("recordings_unsupported")
var ErrRecordingsBusy = errors.New("recordings_busy")
var ErrRecordingsTimeout = errors.New("recordings_timeout")
var ErrRecordingsInvalid = errors.New("recordings_invalid_response")
var ErrRecordingsCapacity = errors.New("recordings_capacity")
var ErrRecordingsReset = errors.New("recordings_connection_reset_required")
var ErrRecordingsUnavailable = errors.New("recordings_unavailable")

type Recording struct {
	StartAt int64 `json:"startAt"`
	EndAt   int64 `json:"endAt"`
	Event   bool  `json:"event"`
}

type RecordingIndex struct {
	Recordings       []Recording
	DiscardedEntries int
}

type recordingReply struct {
	index RecordingIndex
	err   error
}

type recordingRequest struct {
	ctx      context.Context
	command  uint32
	file     chan recordingFileChunk
	done     chan recordingReply
	finished bool // guarded by recordingReader.mu
}

type recordingReader struct {
	init    sync.Once
	slots   chan struct{}
	gate    chan struct{}
	mu      sync.Mutex
	request *recordingRequest
	failed  bool
}

func (p *Producer) ListRecordings(ctx context.Context) (RecordingIndex, error) {
	return p.client.listRecordings(ctx, 0)
}

func (p *dualProducer) ListRecordings(ctx context.Context) (RecordingIndex, error) {
	return p.session.client.listRecordings(ctx, p.recordingChannel())
}

func (c *Client) beginRecordingRequest(ctx context.Context, command uint32) (*recordingRequest, error) {
	if _, ok := c.Conn.(*cs2.Conn); !ok {
		return nil, ErrRecordingsUnsupported
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	r := &c.recordings
	// Both lenses share this physical reader. Admit one request and one waiter;
	// cancellation before acquiring the wire must not fence the active reader.
	r.init.Do(func() {
		r.slots = make(chan struct{}, 2)
		r.gate = make(chan struct{}, 1)
	})
	select {
	case r.slots <- struct{}{}:
	default:
		return nil, ErrRecordingsBusy
	}
	select {
	case r.gate <- struct{}{}:
	case <-ctx.Done():
		<-r.slots
		return nil, ctx.Err()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	err := ctx.Err()
	if err == nil && r.failed {
		err = ErrRecordingsReset
	}
	if err != nil {
		<-r.gate
		<-r.slots
		return nil, err
	}
	request := &recordingRequest{ctx: ctx, command: command, done: make(chan recordingReply, 1)}
	if command == recordingFileCommand {
		request.file = make(chan recordingFileChunk)
	}
	r.request = request
	return request, nil
}

func (c *Client) releaseRecordingRequest(request *recordingRequest, completed bool) {
	r := &c.recordings
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.request == request {
		r.request = nil
	}
	// The wire has no request id. A timed-out/cancelled partial response
	// cannot be assigned to another query in this physical connection.
	if !completed && !request.finished {
		r.failed = true
	}
	<-r.gate
	<-r.slots
}

func (c *Client) writeRecordingCommand(ctx context.Context, command uint32, payload []byte) error {
	plain := make([]byte, 8+len(payload))
	binary.LittleEndian.PutUint32(plain, command)
	binary.LittleEndian.PutUint32(plain[4:], uint32(len(payload)))
	copy(plain[8:], payload)
	encoded, err := crypto.Encode(plain, c.key)
	if err != nil {
		return ErrRecordingsUnavailable
	}
	connection, ok := c.Conn.(*cs2.Conn)
	if !ok {
		return ErrRecordingsUnsupported
	}
	if err := connection.WriteRDT(ctx, encoded); err != nil {
		if errors.Is(err, cs2.ErrRDTBusy) {
			return ErrRecordingsBusy
		}
		return ErrRecordingsUnavailable
	}
	return nil
}

func (c *Client) listRecordings(ctx context.Context, storageChannel uint32) (RecordingIndex, error) {
	ctx, cancel := context.WithTimeout(ctx, recordingQueryTimeout)
	defer cancel()
	request, err := c.beginRecordingRequest(ctx, recordingIndexCommand)
	if err != nil {
		return RecordingIndex{}, err
	}
	completed := false
	defer func() { c.releaseRecordingRequest(request, completed) }()
	// Storage channels are 0 and 10, distinct from the live lens flags 0 and 1.
	payload := make([]byte, 24)
	binary.LittleEndian.PutUint32(payload[8:], storageChannel)
	if err := c.writeRecordingCommand(ctx, recordingIndexCommand, payload); err != nil {
		completed = errors.Is(err, ErrRecordingsBusy)
		return RecordingIndex{}, err
	}
	select {
	case result := <-request.done:
		completed = true
		return result.index, result.err
	case <-ctx.Done():
		c.recordings.mu.Lock()
		finished := request.finished
		c.recordings.mu.Unlock()
		if finished {
			result := <-request.done
			return result.index, result.err
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return RecordingIndex{}, ErrRecordingsTimeout
		}
		return RecordingIndex{}, ctx.Err()
	}
}

func (c *Client) finishRecordingRequest(request *recordingRequest, reply recordingReply, failed bool) {
	r := &c.recordings
	r.mu.Lock()
	defer r.mu.Unlock()
	if failed {
		r.failed = true
	}
	if request != nil && r.request == request && !request.finished {
		request.finished = true
		request.done <- reply
	}
}

func (c *Client) startRecordingReader() {
	connection, ok := c.Conn.(*cs2.Conn)
	if !ok {
		return
	}
	go func() {
		remaining := 0
		var body []byte
		var owner *recordingRequest
		var fileOwner *recordingRequest
		for {
			chunk, err := connection.ReadRDT()
			if err != nil {
				c.recordings.mu.Lock()
				request := c.recordings.request
				c.recordings.mu.Unlock()
				c.finishRecordingRequest(request, recordingReply{err: ErrRecordingsUnavailable}, true)
				return
			}
			c.recordings.mu.Lock()
			failed := c.recordings.failed
			request := c.recordings.request
			if fileOwner != nil && (fileOwner != request || fileOwner.finished) {
				fileOwner = nil
			}
			c.recordings.mu.Unlock()
			if failed {
				continue
			} // Drain bounded transport data without retaining it.
			if len(chunk) < 8 {
				c.finishRecordingRequest(request, recordingReply{err: ErrRecordingsInvalid}, true)
				continue
			}
			plain, err := crypto.Decode(chunk, c.key)
			if err != nil {
				c.finishRecordingRequest(request, recordingReply{err: ErrRecordingsInvalid}, true)
				continue
			}
			if fileOwner != nil {
				select {
				case fileOwner.file <- recordingFileChunk{data: plain}:
				case <-fileOwner.ctx.Done():
				}
				continue
			}
			if remaining == 0 {
				if len(plain) < 8 {
					c.finishRecordingRequest(request, recordingReply{err: ErrRecordingsInvalid}, true)
					continue
				}
				command := binary.LittleEndian.Uint32(plain)
				if request == nil || command != request.command {
					c.finishRecordingRequest(request, recordingReply{err: ErrRecordingsInvalid}, true)
					continue
				}
				remaining = int(binary.LittleEndian.Uint32(plain[4:]))
				if command == recordingFileCommand {
					fileOwner = request
					select {
					case request.file <- recordingFileChunk{first: true, declared: remaining, data: plain[8:]}:
					case <-request.ctx.Done():
					}
					remaining, body, owner = 0, nil, nil
					continue
				}
				// C700 declares only the index table. Its verified four-byte
				// zero prefix is outside that length.
				if remaining > 8*recordingMaxEntries {
					c.finishRecordingRequest(request, recordingReply{err: ErrRecordingsCapacity}, true)
					continue
				}
				if remaining%8 != 0 {
					c.finishRecordingRequest(request, recordingReply{err: ErrRecordingsInvalid}, true)
					continue
				}
				remaining += 4
				owner, body = request, nil
				plain = plain[8:]
			}
			if len(plain) > remaining {
				c.finishRecordingRequest(request, recordingReply{err: ErrRecordingsInvalid}, true)
				continue
			}
			if owner != nil && owner == request {
				body = append(body, plain...)
			}
			remaining -= len(plain)
			if remaining != 0 {
				continue
			}
			if owner != nil && owner == request {
				index, parseError := parseRecordingIndex(body)
				c.finishRecordingRequest(owner, recordingReply{index: index, err: parseError}, false)
			}
			body, owner = nil, nil
		}
	}()
}

func parseRecordingIndex(body []byte) (RecordingIndex, error) {
	if len(body) < 4 {
		return RecordingIndex{}, ErrRecordingsInvalid
	}
	if (len(body)-4)%8 != 0 {
		return RecordingIndex{}, ErrRecordingsInvalid
	}
	if binary.LittleEndian.Uint32(body) != 0 {
		return RecordingIndex{}, ErrRecordingsInvalid
	}
	if len(body) > recordingIndexBytes {
		return RecordingIndex{}, ErrRecordingsCapacity
	}
	index := RecordingIndex{Recordings: make([]Recording, 0)}
	// Fixed-size card indexes include unwritten zero/stale slots. Keep their
	// rejection count visible instead of equating an unknown layout to no card.
	for offset := 4; offset+8 <= len(body); offset += 8 {
		start := binary.LittleEndian.Uint32(body[offset:])
		flags := binary.LittleEndian.Uint32(body[offset+4:])
		if start == 0 && flags == 0 {
			continue
		}
		duration := flags & 255
		if start < recordingMinStart || start > recordingMaxStart || duration == 0 || flags & ^uint32(511) != 0 {
			index.DiscardedEntries++
			continue
		}
		index.Recordings = append(index.Recordings, Recording{
			StartAt: int64(start) * 1000,
			EndAt:   (int64(start) + int64(duration)) * 1000,
			Event:   flags&256 != 0,
		})
	}
	if len(index.Recordings) == 0 && index.DiscardedEntries > 0 {
		return RecordingIndex{}, ErrRecordingsInvalid
	}
	sort.Slice(index.Recordings, func(i, j int) bool { return index.Recordings[i].StartAt < index.Recordings[j].StartAt })
	unique := index.Recordings[:0]
	for _, recording := range index.Recordings {
		if len(unique) == 0 || unique[len(unique)-1].StartAt != recording.StartAt {
			unique = append(unique, recording)
		}
	}
	index.Recordings = unique
	return index, nil
}
