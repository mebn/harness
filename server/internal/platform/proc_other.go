//go:build !windows

package platform

import (
	"os/exec"
	"strconv"
)

func hideWindow(*exec.Cmd) {}

// HasChildProcesses reports whether a process has started others that are still running,
// such as a command running in a shell.
func HasChildProcesses(pid int) bool {
	// pgrep exits 0 when it finds a match.
	return exec.Command("pgrep", "-P", strconv.Itoa(pid)).Run() == nil
}
