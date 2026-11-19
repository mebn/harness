package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// FetchCopilot reads the monthly premium-request quota through the GitHub CLI.
// It uses the same (undocumented) endpoint as the Copilot editor extensions.
func FetchCopilot(ctx context.Context) (Snapshot, error) {
	gh, err := ghPath()
	if err != nil {
		return Snapshot{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, gh, "api", "/copilot_internal/user")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return Snapshot{}, fmt.Errorf("gh api: %w", err)
	}
	return parseCopilot(out, time.Now())
}

func parseCopilot(data []byte, now time.Time) (Snapshot, error) {
	var resp struct {
		QuotaResetDateUTC string `json:"quota_reset_date_utc"`
		QuotaSnapshots    map[string]struct {
			Unlimited        bool    `json:"unlimited"`
			PercentRemaining float64 `json:"percent_remaining"`
			Entitlement      float64 `json:"entitlement"`
			Remaining        float64 `json:"remaining"`
			CreditsUsed      float64 `json:"credits_used"`
		} `json:"quota_snapshots"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return Snapshot{}, err
	}
	premium, ok := resp.QuotaSnapshots["premium_interactions"]
	if !ok {
		return Snapshot{}, errors.New("no premium quota in response")
	}
	w := Window{ID: "month", Label: "Month", Unlimited: premium.Unlimited}
	if t, err := time.Parse("2006-01-02 15:04:05", resp.QuotaResetDateUTC); err == nil {
		w.ResetsAt = t.UnixMilli()
	}
	if premium.Unlimited {
		w.Detail = fmt.Sprintf("%.0f credits used", premium.CreditsUsed)
	} else {
		w.Used = clamp(1 - premium.PercentRemaining/100)
		if premium.Entitlement > 0 {
			w.Detail = fmt.Sprintf("%.0f of %.0f premium requests", premium.Entitlement-premium.Remaining, premium.Entitlement)
		}
	}
	return Snapshot{Provider: "copilot", Windows: []Window{w}, UpdatedAt: now.UnixMilli()}, nil
}

// ghPath finds the GitHub CLI, including the default Windows install location
// (PATH may be stale right after installing it).
func ghPath() (string, error) {
	if p, err := exec.LookPath("gh"); err == nil {
		return p, nil
	}
	if runtime.GOOS == "windows" {
		p := filepath.Join(os.Getenv("ProgramFiles"), "GitHub CLI", "gh.exe")
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", errors.New("GitHub CLI (gh) not found")
}

func clamp(f float64) float64 {
	return max(0, min(1, f))
}
