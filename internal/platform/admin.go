package platform

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// ErrNoElevation explains how to make administrator terminals possible.
var ErrNoElevation = errors.New("administrator terminals need sudo for Windows (Settings › System › " +
	"For developers › Enable sudo, set to Inline) or gsudo (winget install gerardog.gsudo)")

// AdminShellCommand returns a Windows shell that runs as administrator inside the same
// terminal. An elevated process can't simply be started in our pseudo-terminal, so this goes
// through sudo for Windows in inline mode, or gsudo: both show the UAC prompt and then attach
// the elevated shell to the current console.
func AdminShellCommand(dir string) (name string, args []string, err error) {
	if !IsWindows() {
		return "", nil, errors.New("administrator terminals are only available on Windows")
	}
	shell, shellArgs := ShellCommand(EnvNative, dir)
	sudo := filepath.Join(os.Getenv("SystemRoot"), "System32", "sudo.exe")
	if _, err := os.Stat(sudo); err == nil {
		return sudo, append([]string{"--inline", "--chdir", dir, shell}, shellArgs...), nil
	}
	if gsudo, err := exec.LookPath("gsudo"); err == nil {
		return gsudo, append([]string{shell}, shellArgs...), nil
	}
	return "", nil, ErrNoElevation
}
