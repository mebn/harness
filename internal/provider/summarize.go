package provider

import (
	"encoding/json"
	"strings"
)

const maxToolOutput = 64 * 1024

// summarizeInput picks the most descriptive field of a tool input for display.
func summarizeInput(input map[string]any) string {
	for _, key := range []string{"command", "file_path", "path", "pattern", "url", "query", "description", "prompt"} {
		if v, ok := input[key].(string); ok && v != "" {
			return v
		}
	}
	if len(input) == 0 {
		return ""
	}
	b, _ := json.Marshal(input)
	return truncate(string(b), 300)
}

// flattenContent turns a tool result (string or [{type:text,text}]) into text.
func flattenContent(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return truncate(s, maxToolOutput)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var sb strings.Builder
		for _, b := range blocks {
			if b.Type == "text" {
				sb.WriteString(b.Text)
			}
		}
		return truncate(sb.String(), maxToolOutput)
	}
	return truncate(string(raw), maxToolOutput)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n…"
}

// SummarizeInput is a one-line summary of a tool's input.
func SummarizeInput(input map[string]any) string { return summarizeInput(input) }

// ToolArgs is a tool's full input as JSON, cut down when very large.
func ToolArgs(input map[string]any) string { return toolArgs(input) }

// FlattenContent turns a tool result's content into text.
func FlattenContent(raw json.RawMessage) string { return flattenContent(raw) }
