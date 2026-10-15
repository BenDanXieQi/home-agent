package cs2

import (
	"context"
	"encoding/binary"
	"errors"
	"time"
)

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

func (c *Conn) failRDT() {
	c.channels[1].discard = true
	c.channels[1].waitData = nil
	c.channels[1].pushBuf = nil
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
