package xiaomi

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	internalwebrtc "github.com/AlexxIT/go2rtc/internal/webrtc"
	"github.com/AlexxIT/go2rtc/pkg/webrtc"
	"github.com/google/uuid"
)

type homeAgentPlaybackState struct {
	id     string
	cancel context.CancelFunc
}

type homeAgentPlaybackOwner struct {
	SessionID string `json:"sessionId"`
	SourceID  string `json:"sourceId"`

	PlaybackID string `json:"playbackId"`
}

func (owner homeAgentPlaybackOwner) valid() bool {
	_, cameraErr := uuid.Parse(owner.SourceID)
	_, idErr := uuid.Parse(owner.PlaybackID)
	return cameraErr == nil && idErr == nil
}

func homeAgentPlayback(w http.ResponseWriter, r *http.Request) {
	var body struct {
		homeAgentPlaybackOwner
		Offer string `json:"offer"`
	}
	if !homeAgentRead(w, r, &body) {
		return
	}
	if !body.valid() || len(body.Offer) == 0 || len(body.Offer) > 96*1024 {
		homeAgentError(w, "invalid_offer", http.StatusBadRequest)
		return
	}
	homeAgentMu.Lock()
	session := homeAgentRequireSession(w, body.SessionID)
	if session == nil {
		homeAgentMu.Unlock()
		return
	}
	camera := session.cameras[body.SourceID]
	if camera == nil {
		homeAgentMu.Unlock()
		homeAgentError(w, "camera_not_found", http.StatusConflict)
		return
	}
	if r.Context().Err() != nil || session.retired[body.PlaybackID].After(time.Now()) || camera.playbacks[body.PlaybackID] != nil {
		homeAgentMu.Unlock()
		homeAgentError(w, "stale_playback", http.StatusConflict)
		return
	}
	viewers := 0
	for _, source := range session.cameras {
		viewers += len(source.playbacks)
	}
	if viewers >= 32 {
		homeAgentMu.Unlock()
		homeAgentError(w, "stale_playback", http.StatusConflict)
		return
	}
	ownerCtx, ownerCancel := context.WithCancel(camera.ctx)
	playback := &homeAgentPlaybackState{
		id: body.PlaybackID, cancel: ownerCancel,
	}
	camera.playbacks[body.PlaybackID] = playback
	homeAgentMu.Unlock()

	// A viewer has its own deadline and cancellation, independent of the source.
	ctx, cancel := context.WithTimeout(ownerCtx, 50*time.Second)
	defer cancel()
	stopRequestCancellation := context.AfterFunc(r.Context(), cancel)
	defer stopRequestCancellation()
	success := false
	defer func() {
		if success {
			return
		}
		homeAgentMu.Lock()
		homeAgentRetirePlayback(session, camera, playback)
		homeAgentMu.Unlock()
	}()
	select {
	case camera.gate <- struct{}{}:
	case <-ctx.Done():
		homeAgentError(w, "stale_playback", http.StatusConflict)
		return
	}
	releaseGate := sync.OnceFunc(func() { <-camera.gate })
	defer releaseGate()
	if ctx.Err() != nil {
		releaseGate()
		homeAgentError(w, "stale_playback", http.StatusConflict)
		return
	}
	var cleanupOnce sync.Once
	cleanup := func(conn *webrtc.Conn) {
		cleanupOnce.Do(func() {
			homeAgentMu.Lock()
			homeAgentRetirePlayback(session, camera, playback)
			homeAgentMu.Unlock()
			go func() {
				camera.gate <- struct{}{}
				defer func() { <-camera.gate }()
				camera.stream.RemoveConsumer(conn)
			}()
		})
	}
	answer, conn, err := internalwebrtc.HomeAgentOffer(ctx, camera.stream, body.Offer, cleanup)
	releaseGate()
	if err != nil {
		homeAgentError(w, err.Error(), http.StatusBadGateway)
		return
	}
	// Transfer connection lifetime from the request to its explicit owner before
	// publishing the answer. DELETE can cancel even while the answer is in flight.
	context.AfterFunc(ownerCtx, func() {
		_ = conn.Close()
		cleanup(conn)
	})
	homeAgentMu.Lock()
	if homeAgentCurrent.Load() != session || session.cameras[body.SourceID] != camera || camera.playbacks[body.PlaybackID] != playback ||
		session.expires.Load() <= time.Now().UnixNano() || ctx.Err() != nil {
		homeAgentMu.Unlock()
		homeAgentError(w, "stale_playback", http.StatusConflict)
		return
	}
	homeAgentMu.Unlock()
	// A slow HTTP writer never blocks a newer offer or cancellation.
	w.Header().Set("Content-Type", "application/json")
	success = json.NewEncoder(w).Encode(map[string]string{"playbackId": playback.id, "answer": answer}) == nil
}

func homeAgentRelease(w http.ResponseWriter, r *http.Request) {
	var body homeAgentPlaybackOwner
	if !homeAgentRead(w, r, &body) {
		return
	}
	if !body.valid() {
		homeAgentError(w, "invalid_request", http.StatusBadRequest)
		return
	}
	homeAgentMu.Lock()
	defer homeAgentMu.Unlock()
	session := homeAgentRequireSession(w, body.SessionID)
	if session == nil {
		return
	}
	// A DELETE can overtake camera preparation or SDP negotiation. Retain a
	// tombstone beyond every request deadline so that delayed work stays retired.
	session.retired[body.PlaybackID] = time.Now().Add(2 * time.Minute)
	if camera := session.cameras[body.SourceID]; camera != nil {
		if playback := camera.playbacks[body.PlaybackID]; playback != nil {
			homeAgentRetirePlayback(session, camera, playback)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// Caller holds homeAgentMu. Viewer ownership ends on DELETE, failure or peer close;
// the camera's resident consumer remains attached independently.
func homeAgentRetirePlayback(session *homeAgentSession, camera *homeAgentCameraState, playback *homeAgentPlaybackState) {
	if camera.playbacks[playback.id] != playback {
		return
	}
	delete(camera.playbacks, playback.id)
	session.retired[playback.id] = time.Now().Add(2 * time.Minute)
	playback.cancel()
}
