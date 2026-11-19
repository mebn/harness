//go:build windows

package server

import (
	"os/exec"
	"syscall"
)

const (
	createNewProcessGroup  = 0x00000200
	createBreakawayFromJob = 0x01000000
	createNoWindow         = 0x08000000
)

// detach starts cmd in its own process group with no console, optionally outside
// the parent's job object so closing the parent doesn't kill it.
func detach(cmd *exec.Cmd, breakaway bool) {
	flags := uint32(createNewProcessGroup | createNoWindow)
	if breakaway {
		flags |= createBreakawayFromJob
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
}
