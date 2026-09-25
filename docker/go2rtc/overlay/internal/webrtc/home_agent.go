package webrtc

import (
	"context"
	"errors"
	"strings"

	"github.com/AlexxIT/go2rtc/internal/streams"
	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/webrtc"
	pion "github.com/pion/webrtc/v4"
)

// HomeAgentOffer has a read-only media contract and returns the owned connection
// so the caller can explicitly release it. Neither SDP nor source URLs are logged.
func HomeAgentOffer(ctx context.Context, stream *streams.Stream, offer string, cleanup func(*webrtc.Conn)) (string, *webrtc.Conn, error) {
	if ctx.Err() != nil {
		return "", nil, errors.New("signaling_failed")
	}
	pc, err := PeerConnection(false)
	if err != nil {
		return "", nil, errors.New("webrtc_unavailable")
	}
	conn := webrtc.NewConn(pc)
	conn.FormatName = "home-agent/webrtc"
	conn.Protocol = "http"
	conn.Mode = core.ModePassiveConsumer
	conn.Listen(func(msg any) {
		if state, ok := msg.(pion.PeerConnectionState); ok && state == pion.PeerConnectionStateClosed {
			cleanup(conn)
		}
	})
	closeConnection := func() {
		_ = conn.Close()
		cleanup(conn)
	}
	success := false
	defer func() {
		if !success {
			closeConnection()
		}
	}()
	stopCancellation := context.AfterFunc(ctx, closeConnection)
	defer stopCancellation()
	if err = conn.SetOffer(offer); err != nil {
		return "", nil, errors.New("invalid_offer")
	}
	video := false
	for _, media := range conn.GetMedias() {
		if media.Direction != core.DirectionSendonly {
			return "", nil, errors.New("invalid_offer")
		}
		video = video || media.Kind == core.KindVideo
	}
	if !video {
		return "", nil, errors.New("invalid_offer")
	}
	if ctx.Err() != nil {
		return "", nil, errors.New("signaling_failed")
	}
	if err = stream.AddConsumer(conn); err != nil {
		if strings.Contains(err.Error(), "codecs not matched") {
			return "", nil, errors.New("unsupported_codec")
		}
		return "", nil, errors.New("camera_connection_failed")
	}
	answer, err := conn.HomeAgentCompleteAnswer(ctx, GetCandidates(), FilterCandidate)
	if err != nil || ctx.Err() != nil {
		return "", nil, errors.New("signaling_failed")
	}
	success = true
	return answer, conn, nil
}
