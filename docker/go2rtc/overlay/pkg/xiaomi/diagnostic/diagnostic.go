package diagnostic

import (
	"errors"
	"fmt"
	"io"
	"net"
	"syscall"
)

// Report emits only implementation-owned stage/reason labels. Do not print the
// underlying error: network errors and camera responses can contain secrets.
func Report(stage string, err error) {
	reason := "failed"
	var network net.Error
	switch {
	case err == nil:
		reason = "ready"
	case errors.As(err, &network) && network.Timeout():
		reason = "timeout"
	case errors.Is(err, syscall.ECONNREFUSED):
		reason = "connection_refused"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		reason = "network_unreachable"
	case errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EACCES):
		reason = "permission_denied"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		reason = "connection_closed"
	}
	fmt.Printf("[home-agent] stage=%s reason=%s\n", stage, reason)
}
