package miss

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/xiaomi/miss/cs2"
)

const recordingFileCommand = 1
const recordingDownloadTimeout = 90 * time.Second
const recordingDownloadIdle = 3 * time.Second

// C700 replies put four zero bytes before the declared file bytes. This
// response prefix is verified separately and is never forwarded as file data.
const recordingFilePrefixBytes = 4

var ErrRecordingIncomplete = errors.New("recording_incomplete")

type recordingFileChunk struct {
	first    bool
	declared int
	data     []byte
}

// DownloadRecording reads the exact index start second through RDT command 1
// on the resident connection. A successful transport still needs container
// validation before the caller can offer a playable recording.
func (p *Producer) DownloadRecording(ctx context.Context, start uint32, output io.Writer, onStart func(int) error) error {
	return p.client.downloadRecording(ctx, start, output, onStart)
}

func (c *Client) downloadRecording(ctx context.Context, start uint32, output io.Writer, onStart func(int) error) error {
	if start < recordingMinStart || start > recordingMaxStart {
		return ErrRecordingsInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, recordingDownloadTimeout)
	defer cancel()
	request, err := c.beginRecordingRequest(ctx, recordingFileCommand)
	if err != nil {
		return err
	}
	completed := false
	defer func() { c.releaseRecordingRequest(request, completed) }()
	payload := make([]byte, 12)
	binary.LittleEndian.PutUint32(payload, start)
	// The 12-byte request selects storage channel 0; offset 8 is also zero.
	if err := c.writeRecordingCommand(ctx, recordingFileCommand, payload); err != nil {
		completed = errors.Is(err, ErrRecordingsBusy)
		return err
	}

	declared, received := 0, 0
	announced := false
	var prefix [recordingFilePrefixBytes]byte
	prefixRead := 0
	idle := time.NewTimer(recordingDownloadIdle)
	idle.Stop()
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return ErrRecordingsTimeout
			}
			return ctx.Err()
		case reply := <-request.done:
			return reply.err
		case <-idle.C:
			return ErrRecordingIncomplete
		case chunk := <-request.file:
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if chunk.first {
				if declared != 0 || chunk.declared <= 0 {
					return ErrRecordingsInvalid
				}
				if chunk.declared > cs2.MaxRDTFileBytes {
					return ErrRecordingsCapacity
				}
				declared = chunk.declared
			}
			idle.Reset(recordingDownloadIdle)
			if prefixRead < len(prefix) {
				n := copy(prefix[prefixRead:], chunk.data)
				prefixRead += n
				chunk.data = chunk.data[n:]
				if prefixRead < len(prefix) {
					continue
				}
				if binary.LittleEndian.Uint32(prefix[:]) != 0 {
					return ErrRecordingsInvalid
				}
			}
			if len(chunk.data) > declared-received {
				return ErrRecordingsInvalid
			}
			if !announced {
				if err := onStart(declared); err != nil {
					return err
				}
				announced = true
			}
			if len(chunk.data) != 0 {
				n, err := output.Write(chunk.data)
				received += n
				if err != nil {
					return err
				}
				if n != len(chunk.data) {
					return io.ErrShortWrite
				}
			}
			if received == declared {
				c.finishRecordingRequest(request, recordingReply{}, false)
				completed = true
				return nil
			}
		}
	}
}
