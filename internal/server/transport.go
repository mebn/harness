package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/wailsapp/wails/v3/pkg/application"

	"harness/internal/client"
)

// eventBuffer is how many events a slow client may lag behind before it's dropped
// (it reconnects and reloads).
const eventBuffer = 1024

// quitNotice is how long a quitting server waits for EventQuit to reach the windows.
const quitNotice = 300 * time.Millisecond

// QuitWithWindows tells the windows the server is going away, then quits.
func (t *Transport) QuitWithWindows(quit func()) {
	t.Emit(client.EventQuit, nil)
	time.Sleep(quitNotice)
	quit()
}

// Transport serves a normal (windowed-capable) Wails app over local HTTP, the way Wails'
// server mode does, so the server can also own a tray icon:
//
//   - /wails/runtime (bound-method calls) via Wails' own HTTP transport
//   - /wails/events: a WebSocket streaming every event to connected clients
//   - everything else from the asset server (frontend, attachments)
//
// Every request goes through the host's token check.
type Transport struct {
	*application.HTTPTransport
	host    *Host
	assets  http.Handler
	started bool
	srv     *http.Server
	once    sync.Once

	mu       sync.Mutex
	clients  map[chan []byte]struct{}
	desktops int // clients that are the desktop app
}

// HasDesktop reports whether the desktop app is connected (and so receives events).
func (t *Transport) HasDesktop() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.desktops > 0
}

func NewTransport(h *Host) *Transport {
	return &Transport{HTTPTransport: application.NewHTTPTransport(), host: h, clients: map[chan []byte]struct{}{}}
}

// ServeAssets receives Wails' asset server (it already includes the runtime call handler).
func (t *Transport) ServeAssets(assets http.Handler) error {
	t.assets = assets
	return t.serveWhenReady()
}

// Start lets Wails' HTTP transport process calls.
func (t *Transport) Start(ctx context.Context, mp *application.MessageProcessor) error {
	if err := t.HTTPTransport.Start(ctx, mp); err != nil {
		return err
	}
	t.started = true
	return t.serveWhenReady()
}

// serveWhenReady begins serving on the host's listener once calls can be processed and assets
// are known (Wails calls Start and ServeAssets in that order, but don't depend on it), then
// publishes the info file so clients find the server only when it's ready.
func (t *Transport) serveWhenReady() error {
	if !t.started || t.assets == nil {
		return nil
	}
	var err error
	t.once.Do(func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/wails/events", t.serveEvents)
		mux.HandleFunc("/wails/custom.js", serveBrowserEventsJS)
		mux.Handle("/", t.assets)
		t.srv = &http.Server{Handler: t.host.Middleware(mux), ReadHeaderTimeout: 10 * time.Second}
		go func() {
			if err := t.srv.Serve(t.host.Listener()); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("http server: %v", err)
			}
		}()
		err = t.host.Publish()
	})
	return err
}

func (t *Transport) Stop() error {
	if t.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = t.srv.Shutdown(ctx)
	}
	return t.HTTPTransport.Stop()
}

// Emit sends an event to every connected client. The server's services emit through this
// (see services.Emitter), so delivery doesn't depend on Wails' window event plumbing.
func (t *Transport) Emit(name string, data any) {
	msg, err := json.Marshal(struct {
		Name string `json:"name"`
		Data any    `json:"data"`
	}{name, data})
	if err != nil {
		log.Printf("event %s: %v", name, err)
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for ch := range t.clients {
		select {
		case ch <- msg:
		default: // too far behind: disconnect; the client reconnects and reloads
			delete(t.clients, ch)
			close(ch)
		}
	}
}

func (t *Transport) serveEvents(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil) // same-origin browsers and non-browser clients only
	if err != nil {
		return
	}
	defer conn.CloseNow()

	ch := make(chan []byte, eventBuffer)
	desktop := r.Header.Get(client.ClientHeader) == client.ClientDesktop
	t.mu.Lock()
	t.clients[ch] = struct{}{}
	if desktop {
		t.desktops++
	}
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		if _, ok := t.clients[ch]; ok {
			delete(t.clients, ch)
			close(ch)
		}
		if desktop {
			t.desktops--
		}
		t.mu.Unlock()
	}()

	ctx := conn.CloseRead(r.Context()) // clients only listen; this notices disconnects
	for {
		select {
		case <-ctx.Done():
			return
		case data, ok := <-ch:
			if !ok {
				conn.Close(websocket.StatusTryAgainLater, "too slow")
				return
			}
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// serveBrowserEventsJS lets the frontend opened in a browser receive events. The Wails
// runtime loads /wails/custom.js when present.
func serveBrowserEventsJS(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	_, _ = w.Write([]byte(browserEventsJS))
}

const browserEventsJS = `(function () {
  var url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/wails/events";
  function connect() {
    var ws = new WebSocket(url);
    ws.onmessage = function (e) {
      try { window._wails && window._wails.dispatchWailsEvent && window._wails.dispatchWailsEvent(JSON.parse(e.data)); } catch (_) {}
    };
    ws.onclose = function () { setTimeout(connect, 1000); };
    ws.onerror = function () { ws.close(); };
  }
  connect();
})();`
