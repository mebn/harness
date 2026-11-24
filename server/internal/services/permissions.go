package services

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"harness/server/internal/provider"
)

// PendingRequest is a tool call waiting for the user's permission, a question the agent
// asked (AskUserQuestion), a plan waiting for approval (ExitPlanMode), or an MCP server
// asking for input (Elicitation set).
type PendingRequest struct {
	ID          string `json:"id"`
	SessionID   string `json:"sessionId"`
	ToolName    string `json:"toolName"`
	ToolID      string `json:"toolId"`
	Input       string `json:"input"` // the tool's input as JSON
	Title       string `json:"title"`
	Description string `json:"description"`
	Reason      string `json:"reason"`
	BlockedPath string `json:"blockedPath"`
	CanAlways   bool   `json:"canAlways"`
	AlwaysLabel string `json:"alwaysLabel"`
	// FromSubagent is true when a subagent asks.
	FromSubagent bool `json:"fromSubagent"`
	// Feedback is true when a denial can carry a message to the agent.
	Feedback    bool                  `json:"feedback"`
	Elicitation *provider.Elicitation `json:"elicitation"`
	CreatedAt   int64                 `json:"createdAt"`
}

// ChatPending is a session's open requests, oldest first.
type ChatPending struct {
	SessionID string           `json:"sessionId"`
	Items     []PendingRequest `json:"items"`
}

// PermissionAnswer is the user's answer to a PendingRequest.
type PermissionAnswer struct {
	Allow bool `json:"allow"`
	// Always also allows calls like this from now on (the provider's suggested rules).
	Always bool `json:"always"`
	// Message tells the agent why it was denied, or what to do instead.
	Message string `json:"message"`
	// Interrupt stops the turn along with the denial.
	Interrupt bool `json:"interrupt"`
	// Answers to AskUserQuestion: question text -> chosen label(s), comma-separated.
	Answers map[string]string `json:"answers"`
	// Mode to continue in after approving a plan (ExitPlanMode): "ask" | "edits" | "full".
	Mode string `json:"mode"`
	// Content is what the user entered in an MCP server's form (Elicitation). Allow sends
	// it, a plain denial declines, and Interrupt cancels.
	Content map[string]any `json:"content"`
}

// Pending returns every session's open requests.
func (c *ChatService) Pending() []ChatPending {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []ChatPending{}
	for id, ls := range c.live {
		if len(ls.order) > 0 {
			out = append(out, ChatPending{SessionID: id, Items: c.pendingLocked(ls)})
		}
	}
	return out
}

func (c *ChatService) pendingLocked(ls *liveSession) []PendingRequest {
	items := make([]PendingRequest, 0, len(ls.order))
	for _, id := range ls.order {
		p := ls.permissions[id]
		if p == nil {
			continue
		}
		items = append(items, PendingRequest{ID: id, SessionID: ls.sessionID, ToolName: p.ToolName, ToolID: p.ToolID,
			Input: p.Input, Title: p.Title, Description: p.Description, Reason: p.Reason, BlockedPath: p.BlockedPath,
			CanAlways: p.CanAlways, AlwaysLabel: p.AlwaysLabel, FromSubagent: p.AgentID != "", Feedback: p.Feedback,
			Elicitation: p.Elicitation, CreatedAt: ls.asked[id]})
	}
	return items
}

func (c *ChatService) emitPending(ls *liveSession) {
	c.mu.Lock()
	items := c.pendingLocked(ls)
	c.mu.Unlock()
	c.emit(EventChatPending, ChatPending{SessionID: ls.sessionID, Items: items})
}

func (c *ChatService) dropPermissionLocked(ls *liveSession, id string) {
	delete(ls.permissions, id)
	delete(ls.asked, id)
	for i, x := range ls.order {
		if x == id {
			ls.order = append(ls.order[:i:i], ls.order[i+1:]...)
			break
		}
	}
}

// clearPermissionsLocked forgets open requests (the turn ended); reports whether any were open.
func (c *ChatService) clearPermissionsLocked(ls *liveSession) bool {
	had := len(ls.order) > 0
	ls.permissions = map[string]*provider.Permission{}
	ls.asked = map[string]int64{}
	ls.order = nil
	return had
}

// Respond answers an open request.
func (c *ChatService) Respond(sessionID, requestID string, answer PermissionAnswer) error {
	c.mu.Lock()
	ls := c.live[sessionID]
	var p *provider.Permission
	if ls != nil {
		p = ls.permissions[requestID]
		c.dropPermissionLocked(ls, requestID)
	}
	c.mu.Unlock()
	if p == nil {
		return errors.New("this request is no longer open")
	}
	defer c.emitPending(ls)

	var result map[string]any
	switch {
	case p.Elicitation != nil:
		result = elicitationResult(answer)
	case answer.Allow:
		input := map[string]any{}
		_ = json.Unmarshal([]byte(p.Input), &input)
		if p.ToolName == "AskUserQuestion" && answer.Answers != nil {
			input["answers"] = answer.Answers
		}
		result = map[string]any{"behavior": "allow", "updatedInput": input, "toolUseID": p.ToolID}
		var updates []any
		if answer.Always && len(p.Suggestions) > 0 {
			_ = json.Unmarshal(p.Suggestions, &updates)
		}
		if answer.Mode != "" {
			updates = append(updates, map[string]any{"type": "setMode", "mode": provider.ClaudePermissionMode(answer.Mode), "destination": "session"})
		}
		if len(updates) > 0 {
			result["updatedPermissions"] = updates
		}
	default:
		msg := answer.Message
		if msg == "" {
			switch p.ToolName {
			case "AskUserQuestion":
				msg = "The user declined to answer the questions."
			case "ExitPlanMode":
				msg = "The user doesn't want to proceed with this plan yet. Keep planning."
			default:
				msg = "The user doesn't want to proceed with this tool use. The tool use was rejected."
			}
		}
		result = map[string]any{"behavior": "deny", "message": msg, "toolUseID": p.ToolID}
		if answer.Interrupt {
			result["interrupt"] = true
		}
	}
	if err := ls.conn.Respond(requestID, result); err != nil {
		return err
	}
	if answer.Allow && answer.Mode != "" && p.Elicitation == nil {
		c.setMode(ls, answer.Mode)
	}
	return nil
}

// elicitationResult is the reply to an MCP server's request for input.
func elicitationResult(answer PermissionAnswer) map[string]any {
	switch {
	case answer.Allow:
		r := map[string]any{"action": "accept"}
		if answer.Content != nil {
			r["content"] = answer.Content
		}
		return r
	case answer.Interrupt:
		return map[string]any{"action": "cancel"}
	default:
		return map[string]any{"action": "decline"}
	}
}

// setMode records a mode the user chose while answering (approving a plan).
func (c *ChatService) setMode(ls *liveSession, mode string) {
	c.mu.Lock()
	ls.settings.Mode = mode
	c.mu.Unlock()
	if fresh, err := c.store.Session(ls.sessionID); err == nil && fresh.Mode != mode {
		fresh.Mode = mode
		_ = c.store.UpdateSession(&fresh)
		c.emit(EventSessionUpdated, fresh)
	}
}

// ChatCommands is the slash commands available in a session.
type ChatCommands struct {
	SessionID string             `json:"sessionId"`
	Commands  []provider.Command `json:"commands"`
}

// Commands returns the slash commands a session can run. Claude Code reports them when a
// conversation opens, so this opens one when none is known for the folder yet.
func (c *ChatService) Commands(sessionID string) ([]provider.Command, error) {
	sess, err := c.store.Session(sessionID)
	if err != nil {
		return nil, err
	}
	prov, ok := c.providers.Get(sess.Provider)
	if !ok || !prov.Info().Interactive {
		return []provider.Command{}, nil
	}
	loc, err := locate(c.store, sess.ProjectID, sess.Worktree)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if ls := c.live[sessionID]; ls != nil && ls.commands != nil {
		defer c.mu.Unlock()
		return ls.commands, nil
	}
	if cached, ok := c.commands[loc.Dir]; ok {
		c.mu.Unlock()
		return cached, nil
	}
	c.mu.Unlock()

	ls, err := c.ensureLive(sess)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		c.mu.Lock()
		cmds, dead := ls.commands, ls.dead
		c.mu.Unlock()
		if cmds != nil {
			return cmds, nil
		}
		if dead {
			return nil, errors.New("Claude Code exited before listing its commands")
		}
		select {
		case <-tick.C:
		case <-ctx.Done():
			return nil, errors.New("timed out waiting for Claude Code's commands")
		}
	}
}
