package services

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"harness/internal/platform"
	"harness/internal/provider"
	"harness/internal/store"
)

// ClaudeChat is a Claude Code conversation saved on disk for a folder.
type ClaudeChat struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt int64  `json:"updatedAt"`
	Size      int64  `json:"size"`
}

// claudeProjectDir is where Claude Code keeps the conversations started in dir.
func claudeProjectDir(dir string) (string, error) {
	base := os.Getenv("CLAUDE_CONFIG_DIR")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".claude")
	}
	key := []rune(filepath.Clean(dir))
	for i, r := range key {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			key[i] = '-'
		}
	}
	return filepath.Join(base, "projects", string(key)), nil
}

// ClaudeChats lists Claude Code conversations started in a workspace (or one of its
// worktrees) that aren't in Harness yet, newest first.
func (c *ChatService) ClaudeChats(projectID, worktree string) ([]ClaudeChat, error) {
	folder, err := c.claudeFolder(projectID, worktree)
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	if tree, err := c.store.Tree(); err == nil {
		for _, n := range tree {
			for _, s := range n.Sessions {
				known[s.ProviderSessionID] = true
				known[s.ForkFrom] = true
			}
		}
	}
	entries, err := os.ReadDir(folder)
	if errors.Is(err, os.ErrNotExist) {
		return []ClaudeChat{}, nil
	} else if err != nil {
		return nil, err
	}
	out := []ClaudeChat{}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".jsonl")
		if !ok || e.IsDir() || known[id] || uuid.Validate(id) != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		title := claudeChatTitle(filepath.Join(folder, e.Name()))
		if title == "" {
			continue // no conversation in it (e.g. only settings lines)
		}
		out = append(out, ClaudeChat{ID: id, Title: title, UpdatedAt: info.ModTime().UnixMilli(), Size: info.Size()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out, nil
}

func (c *ChatService) claudeFolder(projectID, worktree string) (string, error) {
	loc, err := locate(c.store, projectID, worktree)
	if err != nil {
		return "", err
	}
	if loc.Env.Normalize() == platform.EnvWSL {
		return "", errors.New("importing isn't supported for WSL workspaces yet")
	}
	return claudeProjectDir(loc.Dir)
}

// historyLine is one entry of a Claude Code conversation file.
type historyLine struct {
	Type        string          `json:"type"`
	UUID        string          `json:"uuid"`
	ParentUUID  string          `json:"parentUuid"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	IsCompact   bool            `json:"isCompactSummary"`
	Timestamp   string          `json:"timestamp"`
	Subtype     string          `json:"subtype"`
	AITitle     string          `json:"aiTitle"`
	CustomTitle string          `json:"customTitle"`
	Summary     string          `json:"summary"`
	ToolResult  json.RawMessage `json:"toolUseResult"`
	Message     *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type historyBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     map[string]any  `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (l historyLine) blocks() []historyBlock {
	if l.Message == nil {
		return nil
	}
	var s string
	if json.Unmarshal(l.Message.Content, &s) == nil {
		return []historyBlock{{Type: "text", Text: s}}
	}
	var out []historyBlock
	_ = json.Unmarshal(l.Message.Content, &out)
	return out
}

func readHistory(path string, fn func(historyLine)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		var l historyLine
		if json.Unmarshal(sc.Bytes(), &l) == nil {
			fn(l)
		}
	}
	return sc.Err()
}

// claudeChatTitle is a conversation's title: the one Claude Code gave it, else its first prompt.
func claudeChatTitle(path string) string {
	var title, first string
	_ = readHistory(path, func(l historyLine) {
		switch l.Type {
		case "custom-title":
			title = l.CustomTitle
		case "ai-title":
			if title == "" || title == first {
				title = l.AITitle
			}
		case "summary":
			if title == "" {
				title = l.Summary
			}
		case "user":
			if first == "" && !l.IsMeta && !l.IsSidechain {
				if text, ok := historyPrompt(l); ok {
					first = titleFrom(text)
				}
			}
		}
	})
	if title == "" {
		return first
	}
	return title
}

// historyPrompt returns the text of a prompt the user typed (not a tool result or a
// message Claude Code added).
func historyPrompt(l historyLine) (string, bool) {
	var parts []string
	for _, b := range l.blocks() {
		switch b.Type {
		case "tool_result":
			return "", false
		case "text":
			parts = append(parts, b.Text)
		}
	}
	text := strings.TrimSpace(strings.Join(parts, "\n"))
	if text == "" || strings.HasPrefix(text, "<local-command-") || strings.HasPrefix(text, "<system-reminder>") ||
		strings.HasPrefix(text, "<task-notification>") {
		return "", false
	}
	if name, ok := between(text, "<command-name>", "</command-name>"); ok {
		args, _ := between(text, "<command-args>", "</command-args>")
		return strings.TrimSpace(name + " " + args), true
	}
	return text, true
}

func between(s, start, end string) (string, bool) {
	_, after, ok := strings.Cut(s, start)
	if !ok {
		return "", false
	}
	in, _, ok := strings.Cut(after, end)
	return strings.TrimSpace(in), ok
}

// ImportClaudeChat adds a Claude Code conversation to the workspace as a chat that
// continues it.
func (c *ChatService) ImportClaudeChat(projectID, worktree, id string) (store.Session, error) {
	folder, err := c.claudeFolder(projectID, worktree)
	if err != nil {
		return store.Session{}, err
	}
	if uuid.Validate(id) != nil {
		return store.Session{}, errors.New("invalid conversation id")
	}
	sess := store.Session{ID: uuid.NewString(), ProjectID: projectID, Worktree: worktree, Provider: "claude",
		ProviderSessionID: id, Started: true, Mode: provider.ModeFull}
	if last, ok := c.store.LatestSession(); ok && last.Provider == "claude" {
		sess.Model, sess.Effort, sess.Mode, sess.Fast = last.Model, last.Effort, last.Mode, last.Fast
	} else if p, ok := c.providers.Get("claude"); ok {
		info := p.Info()
		sess.Model, sess.Effort = info.DefaultModel, info.DefaultEffort
	}
	path := filepath.Join(folder, id+".jsonl")
	sess.Title = cmpOr(claudeChatTitle(path), "Imported chat")
	msgs, lastUUID, err := importHistory(path, sess.ID)
	if err != nil {
		return store.Session{}, err
	}
	sess.LastUUID = lastUUID
	if err := c.store.InsertSession(&sess); err != nil {
		return sess, err
	}
	for _, m := range msgs {
		if err := c.store.SaveMessage(m); err != nil {
			return sess, err
		}
	}
	return sess, nil
}

// importHistory converts a conversation file into chat messages.
func importHistory(path, sessionID string) ([]store.Message, string, error) {
	var out []store.Message
	var cur *store.Message // the assistant reply being built
	var last int64
	lastUUID := ""
	stampAt := func(ts string) int64 {
		t, err := time.Parse(time.RFC3339Nano, ts)
		ms := t.UnixMilli()
		if err != nil {
			ms = last
		}
		last = max(last+1, ms)
		return last
	}
	closeReply := func() {
		if cur != nil && len(cur.Parts) > 0 {
			out = append(out, *cur)
		}
		cur = nil
	}
	reply := func(ts string) *store.Message {
		if cur == nil {
			cur = &store.Message{ID: uuid.NewString(), SessionID: sessionID, Role: "assistant", Parts: []store.Part{}, CreatedAt: stampAt(ts)}
		}
		return cur
	}
	err := readHistory(path, func(l historyLine) {
		if l.IsSidechain {
			return
		}
		if l.UUID != "" && (l.Type == "user" || l.Type == "assistant" || l.Type == "system") {
			lastUUID = l.UUID
		}
		switch l.Type {
		case "system":
			if l.Subtype == "compact_boundary" {
				closeReply()
				out = append(out, store.Message{ID: uuid.NewString(), SessionID: sessionID, Role: "event", CreatedAt: stampAt(l.Timestamp),
					Parts: []store.Part{{Type: "compact", Text: "Conversation compacted"}}})
			}
		case "assistant":
			m := reply(l.Timestamp)
			for _, b := range l.blocks() {
				switch b.Type {
				case "text":
					if strings.TrimSpace(b.Text) != "" {
						m.Parts = append(m.Parts, store.Part{Type: "text", Text: b.Text, Done: true})
					}
				case "thinking":
					if strings.TrimSpace(b.Thinking) != "" {
						m.Parts = append(m.Parts, store.Part{Type: "thinking", Text: b.Thinking, Done: true})
					}
				case "tool_use":
					p := store.Part{Type: "tool", ToolID: b.ID, ToolName: b.Name, ToolInput: provider.SummarizeInput(b.Input),
						ToolArgs: provider.ToolArgs(b.Input), Done: true}
					if provider.IsAgentTool(b.Name) {
						p.Subagent, _ = b.Input["subagent_type"].(string)
					}
					m.Parts = append(m.Parts, p)
				}
			}
		case "user":
			if l.IsMeta || l.IsCompact {
				return
			}
			blocks := l.blocks()
			results := false
			for _, b := range blocks {
				if b.Type != "tool_result" || cur == nil {
					continue
				}
				results = true
				for i := range cur.Parts {
					if p := &cur.Parts[i]; p.Type == "tool" && p.ToolID == b.ToolUseID {
						p.ToolOutput, p.IsError = provider.FlattenContent(b.Content), b.IsError
					}
				}
			}
			if results {
				return
			}
			text, ok := historyPrompt(l)
			if !ok {
				return
			}
			closeReply()
			out = append(out, store.Message{ID: l.UUID, SessionID: sessionID, Role: "user", CreatedAt: stampAt(l.Timestamp),
				Parts: []store.Part{{Type: "text", Text: text}}, CLIUUID: l.UUID, PrevUUID: l.ParentUUID})
		}
	})
	closeReply()
	if len(out) == 0 && err == nil {
		err = errors.New("no messages in this conversation")
	}
	return out, lastUUID, err
}
