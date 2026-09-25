package xiaomi

import (
	"net/url"
	"sync"

	"github.com/AlexxIT/go2rtc/internal/streams"
	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/xiaomi/miss"
)

type homeAgentDualCamera struct {
	source   *miss.DualCamera
	channels int
}

// Caller holds homeAgentMu. Ownership is scoped to the runtime account, device
// and address; neither producers nor cloud credentials use a global device cache.
func homeAgentDualStream(session *homeAgentSession, source url.URL, channel int) (*streams.Stream, func()) {
	query := source.Query()
	query.Del("channel")
	source.RawQuery = query.Encode()
	key := source.String()
	if session.dualCameras == nil {
		session.dualCameras = make(map[string]*homeAgentDualCamera)
	}
	shared := session.dualCameras[key]
	if shared == nil {
		shared = &homeAgentDualCamera{source: miss.NewDualCamera(func() (string, error) {
			request := source
			return getCameraURL(&request)
		})}
		session.dualCameras[key] = shared
	}
	shared.channels++
	stream := streams.NewHomeAgentStream(func() (core.Producer, error) { return shared.source.Open(channel) })
	release := sync.OnceFunc(func() {
		shared.channels--
		if shared.channels == 0 {
			shared.source.Close()
			delete(session.dualCameras, key)
		}
	})
	return stream, release
}
