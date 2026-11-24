// Package desktop connects a desktop window to the background server.
//
// The window keeps using the generated Wails bindings. Bound-method calls and attachment
// requests are forwarded to the server, and the server's events are re-emitted locally,
// while window, dialog and other native runtime calls stay in this process.
package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"

	"harness/internal/attach"
	"harness/internal/server"
)

// EventReconnected tells the UI the server connection was re-established (state may have moved on).
const EventReconnected = "server:reconnected"

// Wails runtime object ids that belong to the server (see @wailsio/runtime objectNames).
const (
	objectCall       = 0
	objectCancelCall = 10
)

const runtimePath = "/wails/runtime"

// Bridge forwards backend traffic from the window to the server.
type Bridge struct {
	client *server.Client
	proxy  *httputil.ReverseProxy
}

type ctxKey struct{}

func NewBridge(c *server.Client) *Bridge {
	b := &Bridge{client: c}
	b.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			info := r.In.Context().Value(ctxKey{}).(server.Info)
			target, _ := url.Parse(info.BaseURL())
			r.SetURL(target)
			r.Out.Header.Set(server.TokenHeader, info.Token)
			r.Out.Header.Del("Origin")
			r.Out.Header.Del("Cookie")
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// A request the page gave up on says nothing about the server.
			if r.Context().Err() == nil {
				c.Invalidate(r.Context().Value(ctxKey{}).(server.Info))
			}
			http.Error(w, "Harness server is not reachable: "+err.Error(), http.StatusBadGateway)
		},
	}
	return b
}

// Middleware routes server-bound requests through the proxy and leaves the rest to Wails.
func (b *Bridge) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == server.ConnectionPath {
			b.serveConnection(w, r)
			return
		}
		if !b.forServer(r) {
			next.ServeHTTP(w, r)
			return
		}
		info, err := b.client.Current(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		b.proxy.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, info)))
	})
}

// serveConnection connects to the server (starting it if needed) and reports how that went,
// so the UI can wait for it, or show why it failed, before it loads anything.
func (b *Bridge) serveConnection(w http.ResponseWriter, r *http.Request) {
	res := server.Connection{Connected: true}
	if _, err := b.client.Ensure(r.Context()); err != nil {
		res = server.Connection{Error: err.Error(), LogPath: b.client.LogPath()}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(res)
}

// forServer decides whether a request goes to the server. It may buffer and restore the body.
func (b *Bridge) forServer(r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, attach.URLPrefix) {
		return true
	}
	if r.URL.Path != runtimePath || r.Method != http.MethodPost {
		return false
	}
	body, err := bufferBody(r)
	if err != nil {
		return false
	}
	// Large calls (attachments) arrive in chunks; only bound-method calls are that big.
	if r.Header.Get("x-wails-chunk-id") != "" {
		return true
	}
	var head struct {
		Object int `json:"object"`
	}
	if json.Unmarshal(body, &head) != nil {
		return false
	}
	return head.Object == objectCall || head.Object == objectCancelCall
}

// bufferBody reads the body and puts it back with an exact length. WebView requests don't
// always report one, and the proxy drops bodies whose length looks like zero.
func bufferBody(r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(r.Body)
	r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	return body, err
}

// RelayEvents streams server events into emit until ctx ends, reconnecting as needed.
func (b *Bridge) RelayEvents(ctx context.Context, emit func(name string, data any)) {
	connected := false
	for ctx.Err() == nil {
		info, err := b.client.Current(ctx)
		if err != nil {
			log.Printf("server: %v", err)
			sleep(ctx, 2*time.Second)
			continue
		}
		u := "ws://" + strings.TrimPrefix(info.BaseURL(), "http://") + "/wails/events"
		conn, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{
			HTTPHeader: http.Header{server.TokenHeader: []string{info.Token}},
		})
		if err != nil {
			b.client.Invalidate(info)
			sleep(ctx, time.Second)
			continue
		}
		conn.SetReadLimit(-1) // transcripts can be large
		if connected {
			emit(EventReconnected, nil)
		}
		connected = true
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				break
			}
			var ev struct {
				Name string          `json:"name"`
				Data json.RawMessage `json:"data"`
			}
			if json.Unmarshal(data, &ev) == nil && ev.Name != "" {
				emit(ev.Name, ev.Data)
			}
		}
		conn.CloseNow()
		b.client.Invalidate(info)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
