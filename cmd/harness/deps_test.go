package main

import (
	"os/exec"
	"strings"
	"testing"
)

// The window is a thin client of the server: of this module it may only use the client
// contract, the desktop proxy and the embedded UI. Anything else (store, services,
// providers, ...) belongs to the server process.
func TestWindowImportsOnlyClientPackages(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", ".").Output()
	if err != nil {
		t.Skipf("go list: %v", err)
	}
	allowed := map[string]bool{
		"harness/cmd/harness":      true,
		"harness/internal/client":  true,
		"harness/internal/desktop": true,
		"harness/ui":               true,
	}
	for _, pkg := range strings.Fields(string(out)) {
		if (pkg == "harness" || strings.HasPrefix(pkg, "harness/")) && !allowed[pkg] {
			t.Errorf("the window imports %s; only the server should", pkg)
		}
	}
}
