package streams

import "github.com/AlexxIT/go2rtc/pkg/core"

func NewHomeAgentStream(dial func() (core.Producer, error)) *Stream {
	return &Stream{producers: []*Producer{{url: "xiaomi:private", factory: dial}}}
}

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
