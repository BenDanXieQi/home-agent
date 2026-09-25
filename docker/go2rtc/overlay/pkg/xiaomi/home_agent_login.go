package xiaomi

import (
	"net/http"

	"github.com/AlexxIT/go2rtc/pkg/xiaomi/diagnostic"
)

// LoginHomeAgentSession observes only this new client's login requests. It retains
// LoginWithToken's request, redirect and credential handling without logging them.
func (c *Cloud) LoginHomeAgentSession(userID, passToken string) error {
	previous := c.client.Transport
	next := previous
	if next == nil {
		next = http.DefaultTransport
	}
	c.client.Transport = &homeAgentLoginTransport{next: next}
	defer func() { c.client.Transport = previous }()
	err := c.LoginWithToken(userID, passToken)
	diagnostic.Report("cloud_login", err)
	return err
}

type homeAgentLoginTransport struct {
	next    http.RoundTripper
	started bool
}

func (t *homeAgentLoginTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	stage := "cloud_token_request"
	if t.started {
		stage = "cloud_sts_request"
	}
	t.started = true
	response, err := t.next.RoundTrip(request)
	status := 0
	if response != nil {
		status = response.StatusCode
	}
	diagnostic.ReportHTTP(stage, request.URL.Scheme, status, err)
	return response, err
}
