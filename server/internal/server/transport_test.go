package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestTransportStreamsEvents(t *testing.T) {
	tr := &Transport{clients: map[chan []byte]struct{}{}}
	srv := httptest.NewServer(httpHandlerFunc(tr.serveEvents))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	// Wait until the server has registered the client.
	for {
		tr.mu.Lock()
		n := len(tr.clients)
		tr.mu.Unlock()
		if n == 1 {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("client never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}

	tr.Emit("chat:status", map[string]any{"sessionId": "s1", "running": true})
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ev struct {
		Name string         `json:"name"`
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Name != "chat:status" || ev.Data["sessionId"] != "s1" {
		t.Fatalf("got %s", data)
	}
}

type httpHandlerFunc func(w http.ResponseWriter, r *http.Request)

func (f httpHandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) { f(w, r) }
