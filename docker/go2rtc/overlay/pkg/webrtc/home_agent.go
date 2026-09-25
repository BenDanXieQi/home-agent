package webrtc

import (
	"context"
	"errors"
	"sync"

	"github.com/pion/sdp/v3"
	pion "github.com/pion/webrtc/v4"
)

// HomeAgentCompleteAnswer supports cancellation during ICE gathering. Candidate
// callbacks never block, including when the peer closes before gathering finishes.
func (c *Conn) HomeAgentCompleteAnswer(ctx context.Context, candidates []string, filter func(*pion.ICECandidate) bool) (string, error) {
	var mu sync.Mutex
	complete := pion.GatheringCompletePromise(c.pc)
	c.pc.OnICECandidate(func(candidate *pion.ICECandidate) {
		if candidate != nil && (filter == nil || filter(candidate)) {
			mu.Lock()
			candidates = append(candidates, candidate.ToJSON().Candidate)
			mu.Unlock()
		}
	})
	answer, err := c.GetAnswer()
	if err != nil {
		return "", err
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-complete:
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	description := new(sdp.SessionDescription)
	if err = description.Unmarshal([]byte(answer)); err != nil {
		return "", err
	}
	if len(description.MediaDescriptions) == 0 {
		return "", errors.New("invalid_offer")
	}
	mu.Lock()
	for _, candidate := range candidates {
		description.MediaDescriptions[0].WithPropertyAttribute(candidate)
	}
	mu.Unlock()
	body, err := description.Marshal()
	return string(body), err
}
