package usage

import (
	"testing"
	"time"
)

func TestParseCopilotLimited(t *testing.T) {
	data := []byte(`{"quota_reset_date_utc":"2026-12-01 00:00:00","quota_snapshots":{"premium_interactions":
		{"unlimited":false,"percent_remaining":25,"entitlement":300,"remaining":75}}}`)
	s, err := parseCopilot(data, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	w := s.Windows[0]
	if w.Used != 0.75 || w.Unlimited || w.Detail != "225 of 300 premium requests" || w.ResetsAt == 0 {
		t.Fatalf("window: %+v", w)
	}
}

func TestParseCopilotUnlimited(t *testing.T) {
	data := []byte(`{"quota_snapshots":{"premium_interactions":{"unlimited":true,"credits_used":708}}}`)
	s, err := parseCopilot(data, time.Now())
	if err != nil || !s.Windows[0].Unlimited || s.Windows[0].Detail != "708 credits used" {
		t.Fatalf("got %+v, %v", s, err)
	}
}
