// Package attach stores chat attachments on disk and serves them to the UI.
package attach

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"harness/server/client"
)

// URLPrefix is where the UI loads attachments from (served by Middleware).
const URLPrefix = client.AttachmentsPath

// MaxSize is the largest attachment accepted.
const MaxSize = 20 << 20

// Attachment is a saved file.
type Attachment struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Path     string `json:"path"` // absolute path on disk (host OS)
	URL      string `json:"url"`  // URL the UI can load it from
	Size     int64  `json:"size"`
}

// IsImage reports whether the attachment is an image the agents can view natively.
func (a Attachment) IsImage() bool {
	switch a.MimeType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
}

// Store keeps attachments in Dir/<sessionID>/<uuid><ext>.
type Store struct{ Dir string }

// DefaultDir returns <user config dir>/harness/attachments.
func DefaultDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "harness", "attachments"), nil
}

// Save writes data to disk and returns its descriptor.
func (s Store) Save(sessionID, name, mimeType string, data []byte) (Attachment, error) {
	if len(data) == 0 {
		return Attachment{}, errors.New("empty attachment")
	}
	if len(data) > MaxSize {
		return Attachment{}, fmt.Errorf("%s is larger than %d MB", name, MaxSize>>20)
	}
	if _, err := uuid.Parse(sessionID); err != nil {
		return Attachment{}, errors.New("invalid session id")
	}
	name = filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	if name == "." || name == "/" || name == "" {
		name = "attachment"
	}
	ext := strings.ToLower(filepath.Ext(name))
	if mimeType == "" {
		mimeType = mime.TypeByExtension(ext)
	}
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}

	dir := filepath.Join(s.Dir, sessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Attachment{}, err
	}
	file := uuid.NewString() + ext
	full := filepath.Join(dir, file)
	if err := os.WriteFile(full, data, 0o644); err != nil {
		return Attachment{}, err
	}
	return Attachment{
		Name: name, MimeType: mimeType, Path: full, Size: int64(len(data)),
		URL: URLPrefix + sessionID + "/" + file,
	}, nil
}

// RemoveSession deletes all attachments of a session.
func (s Store) RemoveSession(sessionID string) error {
	if _, err := uuid.Parse(sessionID); err != nil {
		return nil
	}
	return os.RemoveAll(filepath.Join(s.Dir, sessionID))
}

// Middleware serves GET /attachments/<session>/<file> and passes everything else on.
func (s Store) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rest, ok := strings.CutPrefix(r.URL.Path, URLPrefix)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		// Only "<uuid>/<file>" with no traversal is allowed.
		clean := path.Clean("/" + rest)[1:]
		parts := strings.Split(clean, "/")
		if len(parts) != 2 || parts[1] == "" || strings.HasPrefix(parts[1], ".") {
			http.NotFound(w, r)
			return
		}
		if _, err := uuid.Parse(parts[0]); err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		http.ServeFile(w, r, filepath.Join(s.Dir, parts[0], parts[1]))
	})
}
