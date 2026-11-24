// Package usage models plan usage limits per provider (e.g. Claude's 5-hour and
// weekly windows, Copilot's monthly premium requests).
package usage

// Window is one usage limit.
type Window struct {
	ID        string  `json:"id"`        // "five_hour", "seven_day", "month"
	Label     string  `json:"label"`     // short label for the UI: "5h", "Week", "Month"
	Used      float64 `json:"used"`      // fraction 0..1 of the limit consumed
	ResetsAt  int64   `json:"resetsAt"`  // unix ms; 0 when unknown
	Unlimited bool    `json:"unlimited"` // no cap (Used is meaningless)
	Detail    string  `json:"detail"`    // extra info, e.g. "708 credits used"
}

// Snapshot is the latest known usage for a provider.
type Snapshot struct {
	Provider  string   `json:"provider"`
	Windows   []Window `json:"windows"`
	UpdatedAt int64    `json:"updatedAt"` // unix ms
}
