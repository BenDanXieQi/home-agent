package streams

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
