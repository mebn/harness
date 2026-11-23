package platform

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// ErrNoElevation explains how to make administrator terminals and chats possible.
var ErrNoElevation = errors.New("running as administrator needs sudo for Windows (Settings › System › " +
	"For developers › Enable sudo, set to Inline) or gsudo (winget install gerardog.gsudo)")

// AdminShellCommand returns a Windows shell that runs as administrator inside the same
// terminal. An elevated process can't simply be started in our pseudo-terminal, so this goes
// through sudo for Windows in inline mode, or gsudo: both show the UAC prompt and then attach
// the elevated shell to the current console.
func AdminShellCommand(dir string) (name string, args []string, err error) {
	shell, shellArgs := ShellCommand(EnvNative, dir)
	return AdminCommand(dir, shell, shellArgs...)
}

// AdminCommand wraps a native Windows command so it runs as administrator in dir, after a
// UAC prompt, keeping the caller's console or pipes for its input and output.
func AdminCommand(dir, name string, args ...string) (string, []string, error) {
	if !IsWindows() {
		return "", nil, errors.New("running as administrator is only available on Windows")
	}
	if path, err := exec.LookPath(name); err == nil {
		name = path // the elevated side may not search the same PATH
	}
	sudo := filepath.Join(os.Getenv("SystemRoot"), "System32", "sudo.exe")
	if _, err := os.Stat(sudo); err == nil {
		return sudo, append([]string{"--inline", "--chdir", dir, name}, args...), nil
	}
	if gsudo, err := exec.LookPath("gsudo"); err == nil {
		return gsudo, append([]string{name}, args...), nil // gsudo keeps the working directory
	}
	return "", nil, ErrNoElevation
}
