package store

import (
	"path/filepath"
	"testing"
)

func TestSearchMessages(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := Project{ID: "p", Name: "p", Path: "/p", Env: "native"}
	s.InsertProject(&p)
	sess := Session{ID: "s", ProjectID: "p", Title: "t", Provider: "claude", ProviderSessionID: "x"}
	s.InsertSession(&sess)
	s.SaveMessage(Message{ID: "m1", SessionID: "s", Role: "user", CreatedAt: 1,
		Parts: []Part{{Type: "text", Text: "Please fix the Sidebar_collapse bug 100% now"}}})
	s.SaveMessage(Message{ID: "m2", SessionID: "s", Role: "assistant", CreatedAt: 2,
		Parts: []Part{{Type: "tool", ToolName: "Bash", ToolOutput: "sidebar"}}})

	hits, err := s.SearchMessages("sidebar_COLLAPSE", 10)
	if err != nil || len(hits) != 1 || hits[0].MessageID != "m1" {
		t.Fatalf("hits = %+v, err = %v", hits, err)
	}
	// Tool output isn't visible text, so it must not match.
	if hits, _ := s.SearchMessages("100%", 10); len(hits) != 1 {
		t.Fatalf("literal %% search: %+v", hits)
	}
	if hits, _ := s.SearchMessages("nothing-here", 10); len(hits) != 0 {
		t.Fatalf("unexpected hits: %+v", hits)
	}
}
