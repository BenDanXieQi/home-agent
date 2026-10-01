package miss

import (
	"errors"

	"github.com/bluenviron/mediacommon/v2/pkg/codecs/opus"
)

// MISS audio uses sample counts for its RTP clock, shared by single and dual cameras.
func audioSamples(packet *Packet) (uint32, error) {
	if packet.CodecID == codecPCMA && len(packet.Payload) > 0 {
		return uint32(len(packet.Payload)), nil
	}
	if packet.CodecID == codecOPUS {
		samples := opus.PacketDuration2(packet.Payload)
		if samples > 0 && samples <= 5760 {
			return uint32(samples), nil
		}
	}
	return 0, errors.New("xiaomi: invalid audio packet duration")
}
