package streams

import "github.com/AlexxIT/go2rtc/pkg/core"

// The owner supplies a private, scoped dialer; no source or credentials enter a registry.
func NewHomeAgentStream(dial func() (core.Producer, error)) *Stream {
	return &Stream{producers: []*Producer{{url: "xiaomi:private", factory: dial}}}
}

// HomeAgentReconnecting includes both an active dial and its scheduled backoff.
// Observing it must not wait for the producer mutex held during network dialing.
func (s *Stream) HomeAgentReconnecting() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, producer := range s.producers {
		if producer.reconnecting.Load() {
			return true
		}
	}
	return false
}
