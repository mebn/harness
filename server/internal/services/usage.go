package services

import (
	"context"
	"sync"
	"time"

	"harness/server/internal/store"
	"harness/server/internal/usage"
)

// Copilot's quota is fetched from GitHub; don't ask more often than this.
const copilotRefreshEvery = 2 * time.Minute

// UsageService tracks plan usage limits per provider.
// Claude's arrive with each turn; Copilot's are fetched on demand.
type UsageService struct {
	store *store.Store
	emit  Emitter

	mu       sync.Mutex
	fetching bool
}

func NewUsageService(s *store.Store, emit Emitter) *UsageService {
	return &UsageService{store: s, emit: emit}
}

func usageKey(provider string) string { return "usage:" + provider }

// Get returns the last known usage for a provider (Windows is empty if unknown).
// For Copilot a stale value triggers a background refresh that emits "usage:updated".
func (u *UsageService) Get(provider string) usage.Snapshot {
	var snap usage.Snapshot
	if err := u.store.GetJSON(usageKey(provider), &snap); err != nil {
		snap = usage.Snapshot{Provider: provider, Windows: []usage.Window{}}
	}
	if provider == "copilot" && time.Since(time.UnixMilli(snap.UpdatedAt)) > copilotRefreshEvery {
		go u.refreshCopilot()
	}
	return snap
}

func (u *UsageService) refreshCopilot() {
	u.mu.Lock()
	if u.fetching {
		u.mu.Unlock()
		return
	}
	u.fetching = true
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.fetching = false
		u.mu.Unlock()
	}()

	if snap, err := usage.FetchCopilot(context.Background()); err == nil {
		u.record(snap)
	}
}

// record saves a snapshot and notifies the UI. Not exposed to the frontend.
func (u *UsageService) record(snap usage.Snapshot) {
	_ = u.store.SetJSON(usageKey(snap.Provider), snap)
	u.emit(EventUsageUpdated, snap)
}
