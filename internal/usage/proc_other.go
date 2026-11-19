//go:build !windows

package usage

import "os/exec"

func hideWindow(*exec.Cmd) {}
