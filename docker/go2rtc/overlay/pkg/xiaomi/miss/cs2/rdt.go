package cs2

import (
	"context"
	"encoding/binary"
	"errors"
	"time"
)

// RDT carries SD-card metadata and recording files on the existing authenticated CS2 connection.
// Its framing, UDP reordering and acknowledgements use the existing dataChannel.
// A camera can place a whole recording in one encrypted transport message.
// The extra bytes allow the nonce, command/length header and response prefix,
// not extra file data.
const MaxRDTFileBytes = 96 << 20
const maxRDTChunk = MaxRDTFileBytes + 20

var ErrRDTUnavailable = errors.New("xiaomi: recording transport unavailable")
var ErrRDTBusy = errors.New("xiaomi: recording transport busy")

func newRDTChannel() *dataChannel {
	channel := newDataChannel(250, 128)
	channel.maxMessageSize = maxRDTChunk
	channel.maxQueuedBytes = maxRDTChunk
	return channel
}

// Only the connection's receive goroutine changes dataChannel parser state.
func (c *Conn) failRDT() {
	c.channels[1].discard = true
	c.channels[1].waitData = nil
	c.channels[1].pushBuf = nil
	// No more data will be enqueued after discard. Release queued recordings
	// before waking the reader, which otherwise exits and leaves them retained
	// for the lifetime of the still-healthy live-video connection.
	defer c.rdtFailureOnce.Do(func() { close(c.rdtFailed) })
	for {
		select {
		case data, ok := <-c.channels[1].popBuf:
			if !ok {
				return
			}
			c.channels[1].queuedBytes.Add(-int64(len(data)))
		default:
			return
		}
	}
}

func (c *Conn) ReadRDT() ([]byte, error) {
	select {
	case <-c.rdtFailed:
		return nil, ErrRDTUnavailable
	case data, ok := <-c.channels[1].popBuf:
		if !ok {
			return nil, ErrRDTUnavailable
		}
		c.channels[1].queuedBytes.Add(-int64(len(data)))
		return data, nil
	}
}

// One small, read-only request. No media mode change or second camera session.
// UDP loss is reported as a query timeout, never as an empty recording index.
func (c *Conn) WriteRDT(ctx context.Context, payload []byte) error {
	if len(payload) > 1024 {
		return ErrRDTUnavailable
	}
	if !c.cmdMu.TryLock() {
		return ErrRDTBusy
	}
	defer c.cmdMu.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	select {
	case <-c.rdtFailed:
		return ErrRDTUnavailable
	default:
	}
	deadline := time.Now().Add(2 * time.Second)
	if requested, ok := ctx.Deadline(); ok && requested.Before(deadline) {
		deadline = requested
	}
	if err := c.Conn.SetWriteDeadline(deadline); err != nil {
		return ErrRDTUnavailable
	}
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = c.Conn.SetWriteDeadline(time.Now())
		close(interrupted)
	})
	defer func() {
		if !stop() {
			<-interrupted
		}
		_ = c.Conn.SetWriteDeadline(time.Time{})
	}()

	// CS2 data header + one length-prefixed encrypted RDT chunk. Unlike MISS
	// commands there is no 0x1001 command id between length and ciphertext.
	packet := make([]byte, 12+len(payload))
	packet[0], packet[1], packet[4], packet[5] = magic, msgDrw, magicDrw, 1
	binary.BigEndian.PutUint16(packet[2:], uint16(8+len(payload)))
	binary.BigEndian.PutUint16(packet[6:], c.seqCh1)
	c.seqCh1++
	binary.BigEndian.PutUint32(packet[8:], uint32(len(payload)))
	copy(packet[12:], payload)
	if _, err := c.Conn.Write(packet); err != nil {
		return ErrRDTUnavailable
	}
	return nil
}
