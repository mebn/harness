package attach

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func TestSaveAndServe(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	sid := uuid.NewString()
	a, err := s.Save(sid, `C:\evil\..\shot.png`, "", []byte("\x89PNG\r\n\x1a\nfake"))
	if err != nil {
		t.Fatal(err)
	}
	if a.Name != "shot.png" || a.MimeType != "image/png" || !a.IsImage() {
		t.Fatalf("attachment: %+v", a)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) })
	h := s.Middleware(next)
	get := func(url string) int {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
		return rec.Code
	}
	if code := get(a.URL); code != 200 {
		t.Fatalf("serve: %d", code)
	}
	if code := get("/index.html"); code != 299 {
		t.Fatalf("passthrough: %d", code)
	}
	for _, bad := range []string{URLPrefix + "../../etc/passwd", URLPrefix + "notauuid/x.png", URLPrefix + sid + "/../x"} {
		if code := get(bad); code == 200 {
			t.Fatalf("%s served", bad)
		}
	}
}

func TestSaveRejects(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if _, err := s.Save("not-a-uuid", "a.txt", "", []byte("x")); err == nil {
		t.Fatal("accepted bad session id")
	}
	if _, err := s.Save(uuid.NewString(), "a.txt", "", nil); err == nil {
		t.Fatal("accepted empty data")
	}
}
