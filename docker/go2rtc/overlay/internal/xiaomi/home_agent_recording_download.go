package xiaomi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/xiaomi/diagnostic"
	"github.com/AlexxIT/go2rtc/pkg/xiaomi/miss"
)

// A transport chunk may contain a whole recording. Bound aggregate file-transfer
// memory by admitting one download across the runtime; index reads stay per-camera.
var homeAgentRecordingDownloadGate = make(chan struct{}, 1)

type homeAgentRecordingWriter struct {
	response http.ResponseWriter
	ctx      context.Context
	current  func() bool
}

func (w *homeAgentRecordingWriter) Write(data []byte) (int, error) {
	if w.ctx.Err() != nil {
		return 0, w.ctx.Err()
	}
	if !w.current() {
		return 0, context.Canceled
	}
	controller := http.NewResponseController(w.response)
	if err := controller.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return 0, err
	}
	// Register after installing the deadline so an already cancelled context
	// cannot have its interruption overwritten by a later deadline update.
	interrupted := make(chan struct{})
	stop := context.AfterFunc(w.ctx, func() {
		_ = controller.SetWriteDeadline(time.Now())
		close(interrupted)
	})
	defer func() {
		if !stop() {
			<-interrupted
		}
	}()
	n, err := w.response.Write(data)
	if err == nil {
		err = controller.Flush()
	}
	return n, err
}

func homeAgentRecordingDownload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
		SourceID  string `json:"sourceId"`
		StartAt   int64  `json:"startAt"`
	}
	if !homeAgentRead(w, r, &body) {
		return
	}
	if body.StartAt <= 0 || body.StartAt > 4294967295000 || body.StartAt%1000 != 0 {
		homeAgentError(w, "invalid_request", http.StatusBadRequest)
		return
	}
	homeAgentMu.Lock()
	session := homeAgentRequireSession(w, body.SessionID)
	if session == nil {
		homeAgentMu.Unlock()
		return
	}
	camera := session.cameras[body.SourceID]
	if camera == nil || camera.ctx.Err() != nil {
		homeAgentMu.Unlock()
		homeAgentError(w, "camera_not_found", http.StatusConflict)
		return
	}
	reader := camera.recordings
	if reader == nil || !camera.recordingsReady {
		homeAgentMu.Unlock()
		homeAgentError(w, "recording_unavailable", http.StatusConflict)
		return
	}
	ctx, cancel := context.WithTimeout(camera.ctx, 90*time.Second)
	homeAgentMu.Unlock()
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()
	select {
	case homeAgentRecordingDownloadGate <- struct{}{}:
		defer func() { <-homeAgentRecordingDownloadGate }()
	default:
		homeAgentError(w, "recording_busy", http.StatusConflict)
		return
	}
	current := func() bool {
		homeAgentMu.Lock()
		defer homeAgentMu.Unlock()
		return homeAgentCurrent.Load() == session && session.cameras[body.SourceID] == camera &&
			camera.ctx.Err() == nil && camera.recordings == reader && session.expires.Load() > time.Now().UnixNano()
	}
	started := false
	writer := &homeAgentRecordingWriter{response: w, ctx: ctx, current: current}
	err := reader.DownloadRecording(ctx, uint32(body.StartAt/1000), writer, func(declaredBytes int) error {
		if ctx.Err() != nil || !current() {
			return context.Canceled
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(declaredBytes))
		started = true
		_, err := writer.Write(nil)
		return err
	})
	if r.Context().Err() != nil {
		return
	}
	if err == nil && (ctx.Err() != nil || !current()) {
		err = context.Canceled
	}
	if !started {
		code := homeAgentRecordingDownloadError(err)
		status := http.StatusBadGateway
		if errors.Is(err, miss.ErrRecordingsBusy) || errors.Is(err, miss.ErrRecordingsReset) || errors.Is(err, context.Canceled) {
			status = http.StatusConflict
		} else if errors.Is(err, miss.ErrRecordingsTimeout) || errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		homeAgentError(w, code, status)
		return
	}
	if err != nil {
		diagnostic.Report("recording_download_failed", err)
		// Abort a failed body so native HTTP clients cannot accept a partial
		// recording as a completed Content-Length response.
		panic(http.ErrAbortHandler)
	}
}

func homeAgentRecordingDownloadError(err error) string {
	switch {
	case errors.Is(err, miss.ErrRecordingsBusy):
		return "recording_busy"
	case errors.Is(err, miss.ErrRecordingsReset):
		return "recording_connection_reset_required"
	case errors.Is(err, miss.ErrRecordingsCapacity):
		return "recording_capacity_exceeded"
	case errors.Is(err, miss.ErrRecordingIncomplete):
		return "recording_incomplete"
	case errors.Is(err, miss.ErrRecordingsInvalid):
		return "recording_invalid_response"
	case errors.Is(err, miss.ErrRecordingsUnsupported):
		return "recording_unsupported"
	case errors.Is(err, miss.ErrRecordingsTimeout), errors.Is(err, context.DeadlineExceeded):
		return "recording_timeout"
	case errors.Is(err, context.Canceled):
		return "recording_cancelled"
	default:
		return "recording_unavailable"
	}
}
