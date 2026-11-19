// Package store persists projects, sessions and messages in SQLite.
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

const schema = `
CREATE TABLE IF NOT EXISTS projects (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	path       TEXT NOT NULL,
	env        TEXT NOT NULL DEFAULT 'native',
	expanded   INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	id                  TEXT PRIMARY KEY,
	project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	title               TEXT NOT NULL,
	provider            TEXT NOT NULL,
	model               TEXT NOT NULL,
	effort              TEXT NOT NULL,
	mode                TEXT NOT NULL,
	provider_session_id TEXT NOT NULL,
	started             INTEGER NOT NULL DEFAULT 0,
	created_at          INTEGER NOT NULL,
	updated_at          INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
	id         TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	role       TEXT NOT NULL,
	parts      TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`

type Store struct{ db *sql.DB }

// DefaultPath returns $HARNESS_DB, or <user config dir>/harness/harness.db.
func DefaultPath() (string, error) {
	if p := os.Getenv("HARNESS_DB"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "harness", "harness.db"), nil
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// migrate adds columns introduced after the first schema; "duplicate column" means already applied.
func migrate(db *sql.DB) error {
	for _, stmt := range []string{
		`ALTER TABLE sessions ADD COLUMN last_status TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE sessions ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE sessions ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := db.Exec(stmt); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

func now() int64 { return time.Now().UnixMilli() }

// ---- projects ----

func (s *Store) Tree() ([]ProjectTree, error) {
	rows, err := s.db.Query(`SELECT id, name, path, env, expanded, created_at FROM projects ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tree := []ProjectTree{}
	index := map[string]int{}
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.Env, &p.Expanded, &p.CreatedAt); err != nil {
			return nil, err
		}
		index[p.ID] = len(tree)
		tree = append(tree, ProjectTree{Project: p, Sessions: []Session{}})
	}
	sessions, err := s.querySessions(`ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	for _, sess := range sessions {
		if i, ok := index[sess.ProjectID]; ok {
			tree[i].Sessions = append(tree[i].Sessions, sess)
		}
	}
	return tree, nil
}

func (s *Store) Project(id string) (Project, error) {
	var p Project
	err := s.db.QueryRow(`SELECT id, name, path, env, expanded, created_at FROM projects WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Path, &p.Env, &p.Expanded, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

func (s *Store) InsertProject(p *Project) error {
	p.CreatedAt = now()
	_, err := s.db.Exec(`INSERT INTO projects (id, name, path, env, expanded, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.Path, p.Env, p.Expanded, p.CreatedAt)
	return err
}

func (s *Store) UpdateProject(p Project) error {
	_, err := s.db.Exec(`UPDATE projects SET name = ?, path = ?, env = ?, expanded = ? WHERE id = ?`,
		p.Name, p.Path, p.Env, p.Expanded, p.ID)
	return err
}

func (s *Store) DeleteProject(id string) error {
	_, err := s.db.Exec(`DELETE FROM projects WHERE id = ?`, id)
	return err
}

// ---- sessions ----

const sessionCols = `id, project_id, title, provider, model, effort, mode, provider_session_id, started, last_status, context_tokens, context_window, created_at, updated_at`

func scanSession(sc interface{ Scan(...any) error }) (Session, error) {
	var x Session
	err := sc.Scan(&x.ID, &x.ProjectID, &x.Title, &x.Provider, &x.Model, &x.Effort, &x.Mode,
		&x.ProviderSessionID, &x.Started, &x.LastStatus, &x.ContextTokens, &x.ContextWindow, &x.CreatedAt, &x.UpdatedAt)
	return x, err
}

func (s *Store) querySessions(suffix string, args ...any) ([]Session, error) {
	rows, err := s.db.Query(`SELECT `+sessionCols+` FROM sessions `+suffix, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		x, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Store) Session(id string) (Session, error) {
	x, err := scanSession(s.db.QueryRow(`SELECT `+sessionCols+` FROM sessions WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return x, ErrNotFound
	}
	return x, err
}

// LatestSession returns the most recently used session, if any (used for default settings).
func (s *Store) LatestSession() (Session, bool) {
	list, err := s.querySessions(`ORDER BY updated_at DESC LIMIT 1`)
	if err != nil || len(list) == 0 {
		return Session{}, false
	}
	return list[0], true
}

func (s *Store) InsertSession(x *Session) error {
	x.CreatedAt, x.UpdatedAt = now(), now()
	_, err := s.db.Exec(`INSERT INTO sessions (`+sessionCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		x.ID, x.ProjectID, x.Title, x.Provider, x.Model, x.Effort, x.Mode, x.ProviderSessionID, x.Started, x.LastStatus, x.ContextTokens, x.ContextWindow, x.CreatedAt, x.UpdatedAt)
	return err
}

func (s *Store) UpdateSession(x *Session) error {
	x.UpdatedAt = now()
	_, err := s.db.Exec(`UPDATE sessions SET title = ?, provider = ?, model = ?, effort = ?, mode = ?,
		provider_session_id = ?, started = ?, last_status = ?, context_tokens = ?, context_window = ?, updated_at = ? WHERE id = ?`,
		x.Title, x.Provider, x.Model, x.Effort, x.Mode, x.ProviderSessionID, x.Started, x.LastStatus, x.ContextTokens, x.ContextWindow, x.UpdatedAt, x.ID)
	return err
}

func (s *Store) DeleteSession(id string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id = ?`, id)
	return err
}

// ---- messages ----

func (s *Store) Messages(sessionID string) ([]Message, error) {
	rows, err := s.db.Query(`SELECT id, session_id, role, parts, created_at FROM messages WHERE session_id = ? ORDER BY created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		var parts string
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &parts, &m.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(parts), &m.Parts); err != nil {
			m.Parts = []Part{}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SaveMessage inserts or replaces a message.
func (s *Store) SaveMessage(m Message) error {
	parts, err := json.Marshal(m.Parts)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO messages (id, session_id, role, parts, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET parts = excluded.parts`,
		m.ID, m.SessionID, m.Role, string(parts), m.CreatedAt)
	return err
}

// MessageHit is a message whose text matched a search.
type MessageHit struct {
	SessionID string `json:"sessionId"`
	MessageID string `json:"messageId"`
	Role      string `json:"role"`
	Snippet   string `json:"snippet"`
	CreatedAt int64  `json:"createdAt"`
}

// SearchMessages finds messages whose text contains query (case-insensitive), newest first.
func (s *Store) SearchMessages(query string, limit int) ([]MessageHit, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return []MessageHit{}, nil
	}
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
	rows, err := s.db.Query(`SELECT id, session_id, role, parts, created_at FROM messages
		WHERE parts LIKE ? ESCAPE '\' ORDER BY created_at DESC LIMIT ?`, "%"+escaped+"%", limit*3)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MessageHit{}
	for rows.Next() && len(out) < limit {
		var h MessageHit
		var raw string
		if err := rows.Scan(&h.MessageID, &h.SessionID, &h.Role, &raw, &h.CreatedAt); err != nil {
			return nil, err
		}
		var parts []Part
		_ = json.Unmarshal([]byte(raw), &parts)
		// The LIKE matched raw JSON; only keep hits whose visible text matches.
		for _, p := range parts {
			if snip, ok := snippet(p.Text, q); ok {
				h.Snippet = snip
				out = append(out, h)
				break
			}
		}
	}
	return out, rows.Err()
}

// snippet returns ~100 characters of text around the first match of q.
func snippet(text, q string) (string, bool) {
	runes := []rune(text)
	lower := []rune(strings.ToLower(text))
	needle := []rune(strings.ToLower(q))
	idx := -1
	for i := 0; i+len(needle) <= len(lower); i++ {
		if string(lower[i:i+len(needle)]) == string(needle) {
			idx = i
			break
		}
	}
	if idx < 0 {
		return "", false
	}
	start, end := max(0, idx-40), min(len(runes), idx+len(needle)+60)
	s := strings.Join(strings.Fields(string(runes[start:end])), " ")
	if start > 0 {
		s = "…" + s
	}
	if end < len(runes) {
		s += "…"
	}
	return s, true
}

// ---- key/value ----

// GetJSON loads a JSON value stored under key into v. Missing keys return ErrNotFound.
func (s *Store) GetJSON(key string, v any) error {
	var raw string
	err := s.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), v)
}

// SetJSON stores v as JSON under key.
func (s *Store) SetJSON(key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, string(raw))
	return err
}
