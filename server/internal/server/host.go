package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"time"

	"harness/server/client"
)

const (
	tokenCookie   = "harness_token"
	shutdownDelay = 200 * time.Millisecond
)

// Host is the server side: it guards every request with the token and answers
// status/shutdown. It never exits on its own; only an explicit shutdown stops it.
type Host struct {
	Info client.Info

	dataDir  string
	exeMod   int64
	listener net.Listener
	activity func() (runs, terminals int)
	quit     func()
}

// NewHost listens on a free local port and creates a fresh token.
func NewHost(dataDir string) (*Host, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		l.Close()
		return nil, err
	}
	exe, _ := os.Executable()
	h := &Host{
		Info:     client.Info{Port: l.Addr().(*net.TCPAddr).Port, Token: hex.EncodeToString(buf), PID: os.Getpid()},
		dataDir:  dataDir,
		exeMod:   client.ExeModTime(exe),
		listener: l,
	}
	return h, nil
}

// Listener is the socket the server serves on (held from NewHost, so the port can't be taken).
func (h *Host) Listener() net.Listener { return h.listener }

// Activity reports the server's current work (zeros before Start).
func (h *Host) Activity() (runs, terminals int) {
	if h.activity == nil {
		return 0, 0
	}
	return h.activity()
}

// SetHooks sets how the host reports work and stops the application. Call before serving.
func (h *Host) SetHooks(activity func() (runs, terminals int), quit func()) {
	h.activity, h.quit = activity, quit
}

// Publish writes the info file so clients can find this server. Call once it's serving.
func (h *Host) Publish() error { return client.WriteInfo(h.dataDir, h.Info) }

// Close removes the info file so clients don't try a dead server.
func (h *Host) Close() { client.RemoveInfo(h.dataDir, h.Info.PID) }

func (h *Host) status() client.Status {
	runs, terms := h.Activity()
	return client.Status{PID: h.Info.PID, ExeModTime: h.exeMod, Runs: runs, Terminals: terms}
}

// Middleware authenticates every request and serves /api/status and /api/shutdown.
// A browser can sign in once with ?token=..., which sets a cookie.
func (h *Host) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query().Get("token"); q != "" && h.validToken(q) {
			http.SetCookie(w, &http.Cookie{Name: tokenCookie, Value: q, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			u := *r.URL
			query := u.Query()
			query.Del("token")
			u.RawQuery = query.Encode()
			http.Redirect(w, r, u.String(), http.StatusFound)
			return
		}
		if !h.authorized(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		switch r.URL.Path {
		case client.ConnectionPath:
			// A browser talks to the server directly, so it is connected by definition.
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(client.Connection{Connected: true})
			return
		case "/api/status":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(h.status())
			return
		case "/api/shutdown":
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			go func() {
				time.Sleep(shutdownDelay) // let the response go out first
				h.quit()
			}()
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Host) authorized(r *http.Request) bool {
	if t := r.Header.Get(client.TokenHeader); t != "" {
		return h.validToken(t)
	}
	if c, err := r.Cookie(tokenCookie); err == nil {
		return h.validToken(c.Value)
	}
	return false
}

func (h *Host) validToken(t string) bool {
	return subtle.ConstantTimeCompare([]byte(t), []byte(h.Info.Token)) == 1
}
