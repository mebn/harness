//go:build windows

package platform

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

// hideWindow prevents a console window from flashing for child processes.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
