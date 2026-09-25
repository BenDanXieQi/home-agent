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
	fmt.Printf("[home-agent] stage=%s reason=%s\n", stage, failureReason(err))
}

// ReportHTTP never renders the request URL, response body, headers or underlying error.
func ReportHTTP(stage, scheme string, status int, err error) {
	reason := failureReason(err)
	if status < 100 || status > 599 {
		status = 0
	}
	if err == nil && status >= 400 {
		reason = "http_error"
	}
	if scheme == "http" || scheme == "https" {
		fmt.Printf("[home-agent] stage=%s reason=%s status=%d destination_scheme=%s\n", stage, reason, status, scheme)
		return
	}
	fmt.Printf("[home-agent] stage=%s reason=%s status=%d\n", stage, reason, status)
}

func failureReason(err error) string {
	reason := "failed"
	var network net.Error
	var dns *net.DNSError
	switch {
	case err == nil:
		reason = "ready"
	case errors.As(err, &network) && network.Timeout():
		reason = "timeout"
	case errors.As(err, &dns):
		reason = "dns_error"
	case errors.Is(err, syscall.ECONNREFUSED):
		reason = "connection_refused"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		reason = "network_unreachable"
	case errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EACCES):
		reason = "permission_denied"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		reason = "connection_closed"
	}
	return reason
}
