package xiaomi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// Timing belongs to one viewer and never acquires session or camera ownership
// locks. Durations use time.Time's monotonic clock within this process.
type homeAgentPlaybackTiming struct {
	mu        sync.Mutex
	attemptID string
	started   time.Time
	finished  time.Time
	telemetry homeAgentPlaybackTelemetry
}

type homeAgentPlaybackTelemetry struct {
	Stage                string `json:"stage"`
	ElapsedMs            int64  `json:"elapsedMs"`
	SourceRecentlyActive bool   `json:"sourceRecentlyActive"`
	Timings              struct {
		QueueMs  *int64 `json:"queueMs,omitempty"`
		SourceMs *int64 `json:"sourceMs,omitempty"`
		AnswerMs *int64 `json:"answerMs,omitempty"`
	} `json:"timings"`
}

func homeAgentNewPlaybackTiming(playbackID string, started time.Time, sourceRecentlyActive bool) *homeAgentPlaybackTiming {
	digest := sha256.Sum256([]byte(playbackID))
	return &homeAgentPlaybackTiming{
		attemptID: hex.EncodeToString(digest[:8]),
		started:   started,
		telemetry: homeAgentPlaybackTelemetry{Stage: "queued", SourceRecentlyActive: sourceRecentlyActive},
	}
}

func (t *homeAgentPlaybackTiming) snapshot() homeAgentPlaybackTelemetry {
	t.mu.Lock()
	defer t.mu.Unlock()
	result := t.telemetry
	end := t.finished
	if end.IsZero() {
		end = time.Now()
	}
	result.ElapsedMs = max(0, end.Sub(t.started).Milliseconds())
	return result
}

func (t *homeAgentPlaybackTiming) observe(stage string, elapsed time.Duration, err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	ms := max(0, elapsed.Milliseconds())
	switch stage {
	case "queue":
		t.telemetry.Timings.QueueMs = &ms
		if err == nil {
			t.telemetry.Stage = "connecting"
		}
	case "source":
		t.telemetry.Timings.SourceMs = &ms
		if err == nil {
			t.telemetry.Stage = "signaling"
		}
	case "answer":
		t.telemetry.Timings.AnswerMs = &ms
		if err == nil {
			t.telemetry.Stage = "answer_ready"
		}
	}
	if err != nil || t.telemetry.Stage == "answer_ready" {
		t.finished = time.Now()
	}
}

// Early offer validation can fail before any timed source operation completes.
// Freeze those failures before writing an HTTP response or emitting diagnostics.
func (t *homeAgentPlaybackTiming) finish() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.finished.IsZero() {
		t.finished = time.Now()
	}
}

// attempt_id is a SHA-256 digest prefix shared with the backend. It correlates
// viewer measurements without exposing the resource ID, camera or credentials.
func (t *homeAgentPlaybackTiming) report(code string) {
	body, _ := json.Marshal(struct {
		Event     string                     `json:"event"`
		AttemptID string                     `json:"attempt_id"`
		Code      string                     `json:"code"`
		Telemetry homeAgentPlaybackTelemetry `json:"telemetry"`
	}{"playback_negotiation", t.attemptID, code, t.snapshot()})
	fmt.Printf("[home-agent] %s\n", body)
}
