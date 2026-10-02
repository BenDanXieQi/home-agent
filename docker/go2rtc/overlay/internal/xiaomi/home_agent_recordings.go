package xiaomi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/xiaomi/miss"
)

// This reader is attached by the resident producer factory; reading a card never
// dials a camera, modifies recording settings or switches its live media mode.
func homeAgentRecordings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
		SourceID  string `json:"sourceId"`
		AfterMs   int64  `json:"afterMs"`
		Limit     int    `json:"limit"`
	}
	if !homeAgentRead(w, r, &body) {
		return
	}
	if body.AfterMs < 0 || body.AfterMs > 4294967295000 || body.Limit < 1 || body.Limit > 1000 {
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
	reason := ""
	if !camera.singleLens {
		reason = "unsupported_source"
	} else if !camera.recordingsReady {
		reason = "not_ready"
	} else if reader == nil {
		reason = "unsupported_source"
	}
	ctx, cancel := context.WithCancel(camera.ctx)
	homeAgentMu.Unlock()
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()

	var index miss.RecordingIndex
	if reason == "" {
		var err error
		index, err = reader.ListRecordings(ctx)
		switch {
		case err == nil:
		case errors.Is(err, miss.ErrRecordingsUnsupported):
			reason = "unsupported_source"
		case errors.Is(err, miss.ErrRecordingsBusy):
			reason = "busy"
		case errors.Is(err, miss.ErrRecordingsTimeout):
			reason = "timeout"
		case errors.Is(err, miss.ErrRecordingsInvalid):
			reason = "invalid_response"
		case errors.Is(err, miss.ErrRecordingsCapacity):
			reason = "capacity_exceeded"
		case errors.Is(err, miss.ErrRecordingsReset):
			reason = "connection_reset_required"
		default:
			reason = "connection_unavailable"
		}
	}
	if r.Context().Err() != nil {
		return
	}
	homeAgentMu.Lock()
	current := homeAgentCurrent.Load() == session && session.cameras[body.SourceID] == camera &&
		camera.ctx.Err() == nil && camera.recordings == reader && session.expires.Load() > time.Now().UnixNano()
	homeAgentMu.Unlock()
	if !current {
		homeAgentError(w, "stale_playback", http.StatusConflict)
		return
	}
	controller := http.NewResponseController(w)
	if controller.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if reason != "" {
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "unavailable", "reason": reason})
		return
	}
	first := sort.Search(len(index.Recordings), func(i int) bool { return index.Recordings[i].StartAt > body.AfterMs })
	last := min(first+body.Limit, len(index.Recordings))
	var next *int64
	if last < len(index.Recordings) {
		value := index.Recordings[last-1].StartAt
		next = &value
	}
	_ = json.NewEncoder(w).Encode(struct {
		Status           string           `json:"status"`
		Recordings       []miss.Recording `json:"recordings"`
		TotalClips       int              `json:"totalClips"`
		NextAfterMs      *int64           `json:"nextAfterMs"`
		DiscardedEntries int              `json:"discardedEntries"`
	}{"ready", index.Recordings[first:last], len(index.Recordings), next, index.DiscardedEntries})
}
