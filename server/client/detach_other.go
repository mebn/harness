//go:build !windows

package client

import (
	"os/exec"
	"syscall"
)

// detach starts cmd in a new session so it survives the parent and its terminal.
func detach(cmd *exec.Cmd, _ bool) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
