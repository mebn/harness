package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"harness/server/client"
)

func newTestHost(t *testing.T) (*Host, http.Handler) {
	t.Helper()
	h, err := NewHost(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Listener().Close() })
	h.SetHooks(func() (int, int) { return 2, 1 }, func() {})
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	return h, h.Middleware(next)
}

func TestMiddlewareRejectsMissingOrWrongToken(t *testing.T) {
	_, mw := newTestHost(t)
	for _, tok := range []string{"", "wrong"} {
		req := httptest.NewRequest(http.MethodPost, "/wails/runtime", nil)
		if tok != "" {
			req.Header.Set(client.TokenHeader, tok)
		}
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("token %q: got %d, want 401", tok, rec.Code)
		}
	}
}

func TestMiddlewarePassesWithHeaderOrCookie(t *testing.T) {
	h, mw := newTestHost(t)

	req := httptest.NewRequest(http.MethodPost, "/wails/runtime", nil)
	req.Header.Set(client.TokenHeader, h.Info.Token)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot {
		t.Fatalf("header: got %d, want pass-through", rec.Code)
	}

	// ?token= logs a browser in with a cookie and strips the token from the URL.
	rec = httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/?token="+h.Info.Token+"&x=1", nil))
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/?x=1" {
		t.Fatalf("login: got %d to %q", rec.Code, rec.Header().Get("Location"))
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly {
		t.Fatalf("login cookie: %+v", cookies)
	}
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(cookies[0])
	rec = httptest.NewRecorder()
	mw.ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot {
		t.Fatalf("cookie: got %d, want pass-through", rec.Code)
	}
}

func TestStatus(t *testing.T) {
	h, mw := newTestHost(t)
	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Header.Set(client.TokenHeader, h.Info.Token)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)
	var st client.Status
	if err := json.NewDecoder(rec.Body).Decode(&st); err != nil {
		t.Fatal(err)
	}
	if st.PID != h.Info.PID || st.Runs != 2 || st.Terminals != 1 {
		t.Fatalf("status: %+v", st)
	}
}

func TestInfoRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := client.Info{Port: 1234, Token: "abc", PID: 42}
	if err := client.WriteInfo(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := client.ReadInfo(dir)
	if err != nil || got != want {
		t.Fatalf("got %+v, %v", got, err)
	}
	client.RemoveInfo(dir, 7) // another server's pid: keep
	if _, err := client.ReadInfo(dir); err != nil {
		t.Fatal("info removed by a different pid")
	}
	client.RemoveInfo(dir, 42)
	if _, err := client.ReadInfo(dir); err == nil {
		t.Fatal("info not removed")
	}
}
