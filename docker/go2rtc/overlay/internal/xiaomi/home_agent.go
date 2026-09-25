package xiaomi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/AlexxIT/go2rtc/internal/api"
	"github.com/AlexxIT/go2rtc/pkg/xiaomi"
	"github.com/google/uuid"
)

const homeAgentLease = 60 * time.Second

type homeAgentSession struct {
	id          string
	alias       string
	region      string
	expires     atomic.Int64
	cameras     map[string]*homeAgentCameraState
	retired     map[string]time.Time
	dualCameras map[string]*homeAgentDualCamera
}

var homeAgentCurrent atomic.Pointer[homeAgentSession]
var homeAgentMu sync.Mutex
var homeAgentIdentifier = regexp.MustCompile(`^[0-9]{1,32}$`)

func initHomeAgent() {
	api.HandleFunc("api/home-agent/mijia/", homeAgentAPI)
	go func() {
		for range time.NewTicker(5 * time.Second).C {
			homeAgentMu.Lock()
			if session := homeAgentCurrent.Load(); session != nil && session.expires.Load() < time.Now().UnixNano() {
				homeAgentClear()
			}
			if session := homeAgentCurrent.Load(); session != nil {
				for id, until := range session.retired {
					if time.Now().After(until) {
						delete(session.retired, id)
					}
				}
			}
			homeAgentMu.Unlock()
		}
	}()
}

// The host publishes go2rtc only on loopback. Docker forwards host requests from
// its private gateway; private peers are accepted, browser origins are never accepted.
func homeAgentLocalRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	return err == nil && ip != nil && (ip.IsLoopback() || ip.IsPrivate()) &&
		r.Header.Get("Origin") == "" && r.Header.Get("Sec-Fetch-Site") == "" &&
		r.Header.Get("X-Home-Agent") == "mijia" && r.URL.RawQuery == ""
}

func homeAgentError(w http.ResponseWriter, code string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
}

func homeAgentRead(w http.ResponseWriter, r *http.Request, target any) bool {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		homeAgentError(w, "invalid_request", http.StatusUnsupportedMediaType)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil || decoder.Decode(new(any)) != io.EOF {
		homeAgentError(w, "invalid_request", http.StatusBadRequest)
		return false
	}
	return true
}

func homeAgentAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !homeAgentLocalRequest(r) {
		homeAgentError(w, "local_access_required", http.StatusForbidden)
		return
	}
	action := strings.TrimPrefix(r.URL.Path, "/api/home-agent/mijia/")
	if action == "heartbeat" && r.Method == http.MethodPost {
		var body struct {
			SessionID string `json:"sessionId"`
		}
		if !homeAgentRead(w, r, &body) {
			return
		}
		homeAgentMu.Lock()
		session := homeAgentRequireSession(w, body.SessionID)
		if session == nil {
			homeAgentMu.Unlock()
			return
		}
		session.expires.Store(time.Now().Add(homeAgentLease).UnixNano())
		ids := make([]string, 0)
		for _, camera := range session.cameras {
			for id := range camera.playbacks {
				ids = append(ids, id)
			}
		}
		homeAgentMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"playbackIds": ids})
		return
	}

	if action == "playback" {
		switch r.Method {
		case http.MethodPost:
			homeAgentPlayback(w, r)
		case http.MethodDelete:
			homeAgentRelease(w, r)
		default:
			homeAgentError(w, "invalid_request", http.StatusNotFound)
		}
		return
	}

	homeAgentMu.Lock()
	defer homeAgentMu.Unlock()
	// A timed-out management request must not replace a newer camera or
	// reset a subsequently established session.
	if r.Context().Err() != nil {
		return
	}
	if session := homeAgentCurrent.Load(); session != nil && session.expires.Load() <= time.Now().UnixNano() {
		homeAgentClear()
	}
	switch {
	case action == "session" && r.Method == http.MethodPut:
		homeAgentInstall(w, r)
	case action == "session" && r.Method == http.MethodDelete:
		var body struct {
			SessionID string `json:"sessionId,omitempty"`
			Reset     bool   `json:"reset,omitempty"`
		}
		if !homeAgentRead(w, r, &body) {
			return
		}
		if !body.Reset && homeAgentRequireSession(w, body.SessionID) == nil {
			return
		}
		homeAgentClear()
		w.WriteHeader(http.StatusNoContent)
	case action == "camera" && r.Method == http.MethodPut:
		homeAgentCamera(w, r)
	case action == "camera" && r.Method == http.MethodDelete:
		var body struct {
			SessionID string `json:"sessionId"`
			SourceID  string `json:"sourceId"`
		}
		if !homeAgentRead(w, r, &body) {
			return
		}
		session := homeAgentRequireSession(w, body.SessionID)
		if session == nil {
			return
		}
		if _, err := uuid.Parse(body.SourceID); err != nil {
			homeAgentError(w, "invalid_request", http.StatusBadRequest)
			return
		}
		session.retired[body.SourceID] = time.Now().Add(2 * time.Minute)
		if camera := session.cameras[body.SourceID]; camera != nil {
			delete(session.cameras, body.SourceID)
			homeAgentCloseCamera(camera)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		homeAgentError(w, "invalid_request", http.StatusNotFound)
	}
}

func homeAgentRequireSession(w http.ResponseWriter, id string) *homeAgentSession {
	session := homeAgentCurrent.Load()
	if session == nil || session.id != id || session.expires.Load() <= time.Now().UnixNano() {
		homeAgentError(w, "session_expired", http.StatusConflict)
		return nil
	}
	return session
}

func homeAgentInstall(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
		UserID    string `json:"userId"`
		PassToken string `json:"passToken"`
		Region    string `json:"region"`
	}
	if !homeAgentRead(w, r, &body) {
		return
	}
	if _, err := uuid.Parse(body.SessionID); err != nil || !homeAgentIdentifier.MatchString(body.UserID) ||
		len(body.PassToken) == 0 || len(body.PassToken) > 8192 ||
		strings.ContainsAny(body.PassToken, ";\r\n\x00") || body.Region != "cn" {
		homeAgentError(w, "invalid_credentials", http.StatusBadRequest)
		return
	}
	// Clear first so failed installation cannot retain an old account's picture.
	homeAgentClear()
	cloud := xiaomi.NewCloud(AppXiaomiHome)
	err := cloud.LoginHomeAgentSession(body.UserID, body.PassToken)
	if r.Context().Err() != nil {
		return
	}
	if err != nil {
		homeAgentError(w, homeAgentCloudErrorCode(err), http.StatusBadGateway)
		return
	}
	alias := "home-agent-" + uuid.NewString()
	cloudsMu.Lock()
	if clouds == nil {
		clouds = make(map[string]*xiaomi.Cloud)
	}
	clouds[alias] = cloud
	cloudsMu.Unlock()
	session := &homeAgentSession{id: body.SessionID, alias: alias, region: body.Region, cameras: make(map[string]*homeAgentCameraState), retired: make(map[string]time.Time)}
	session.expires.Store(time.Now().Add(homeAgentLease).UnixNano())
	homeAgentCurrent.Store(session)
	w.WriteHeader(http.StatusNoContent)
}

func homeAgentCloudErrorCode(err error) string {
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		return "request_timeout"
	}
	var operation *net.OpError
	var dns *net.DNSError
	if errors.As(err, &operation) || errors.As(err, &dns) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, xiaomi.ErrCloudUnavailable) {
		return "go2rtc_unavailable"
	}
	return "credentials_rejected"
}

// Caller holds homeAgentMu. Static token config and other account caches remain intact.
func homeAgentClear() {
	session := homeAgentCurrent.Swap(nil)
	if session == nil {
		return
	}
	for key, camera := range session.cameras {
		delete(session.cameras, key)
		homeAgentCloseCamera(camera)
	}
	for _, camera := range session.dualCameras {
		camera.source.Close()
	}
	session.dualCameras = nil
	cloudsMu.Lock()
	delete(clouds, session.alias)
	cloudsMu.Unlock()
}
