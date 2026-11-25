package desktop

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"harness/internal/client"
)

func TestForServerRouting(t *testing.T) {
	b := &Bridge{}
	cases := []struct {
		name, method, path, body string
		chunked                  bool
		want                     bool
	}{
		{"bound call", "POST", runtimePath, `{"object":0,"method":0}`, false, true},
		{"cancel call", "POST", runtimePath, `{"object":10,"method":0}`, false, true},
		{"window call", "POST", runtimePath, `{"object":6,"method":3}`, false, false},
		{"dialog call", "POST", runtimePath, `{"object":5,"method":1}`, false, false},
		{"chunk", "POST", runtimePath, `raw-bytes`, true, true},
		{"attachment", "GET", "/attachments/x/y.png", ``, false, true},
		{"asset", "GET", "/assets/index.js", ``, false, false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		if c.chunked {
			r.Header.Set("x-wails-chunk-id", "abc")
		}
		if got := b.forServer(r); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
		// The body must still be readable by whoever handles the request.
		if got, _ := io.ReadAll(r.Body); string(got) != c.body {
			t.Errorf("%s: body after routing = %q", c.name, got)
		}
	}
}

// WebView requests may report no length; the forwarded call must still carry its body.
func TestProxyForwardsBodyWithoutContentLength(t *testing.T) {
	var got, token string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got, token = string(b), r.Header.Get(client.TokenHeader)
	}))
	defer upstream.Close()
	port, _ := strconv.Atoi(upstream.URL[strings.LastIndex(upstream.URL, ":")+1:])
	info := client.Info{Port: port, Token: "secret"}

	body := `{"object":0,"method":0,"args":{"methodID":1}}`
	r := httptest.NewRequest(http.MethodPost, runtimePath, strings.NewReader(body))
	r.ContentLength = 0
	b := NewBridge(client.New(t.TempDir(), ""))
	if !b.forServer(r) {
		t.Fatal("not routed to server")
	}
	b.proxy.ServeHTTP(httptest.NewRecorder(), r.WithContext(context.WithValue(r.Context(), ctxKey{}, info)))
	if got != body || token != "secret" {
		t.Fatalf("upstream got body %q token %q", got, token)
	}
}
