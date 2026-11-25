// Package platform hides OS differences: where commands run (native or WSL),
// how paths translate between Windows and Linux, and which shell to use.
package platform

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Env is the execution environment for a project.
type Env string

const (
	EnvNative Env = "native"
	EnvWSL    Env = "wsl"
)

// Normalize returns a valid Env, falling back to native when WSL is unusable.
func (e Env) Normalize() Env {
	if e == EnvWSL && HasWSL() {
		return EnvWSL
	}
	return EnvNative
}

func IsWindows() bool { return runtime.GOOS == "windows" }

var (
	wslOnce sync.Once
	wslOK   bool
)

// HasWSL reports whether WSL is installed with at least one distro.
func HasWSL() bool {
	wslOnce.Do(func() {
		if !IsWindows() {
			return
		}
		cmd := exec.Command("wsl.exe", "--list", "--quiet")
		hideWindow(cmd)
		out, err := cmd.Output()
		// wsl.exe emits UTF-16; any non-NUL, non-space byte means a distro exists.
		wslOK = err == nil && strings.TrimSpace(strings.ReplaceAll(string(out), "\x00", "")) != ""
	})
	return wslOK
}

// EnvForPath infers where a folder's tools run: folders stored inside a WSL
// distro (\\wsl.localhost\... or \\wsl$\...) run in WSL, everything else natively.
func EnvForPath(p string) Env {
	if distro, _ := ToWSLPath(p); distro != "" && HasWSL() {
		return EnvWSL
	}
	return EnvNative
}

// PathFor returns how a host path is spelled inside env (e.g. /mnt/c/... in WSL).
func PathFor(env Env, hostPath string) string {
	if env.Normalize() == EnvWSL {
		_, p := ToWSLPath(hostPath)
		return p
	}
	return hostPath
}

// ToWSLPath converts a Windows path to a Linux path inside WSL.
// UNC paths (\\wsl.localhost\Distro\... or \\wsl$\Distro\...) also yield the distro.
func ToWSLPath(p string) (distro, linuxPath string) {
	clean := strings.ReplaceAll(p, "/", `\`)
	lower := strings.ToLower(clean)
	for _, prefix := range []string{`\\wsl.localhost\`, `\\wsl$\`} {
		if strings.HasPrefix(lower, prefix) {
			rest := clean[len(prefix):]
			parts := strings.SplitN(rest, `\`, 2)
			distro = parts[0]
			linuxPath = "/"
			if len(parts) == 2 {
				linuxPath += strings.ReplaceAll(parts[1], `\`, "/")
			}
			return distro, linuxPath
		}
	}
	if len(clean) >= 2 && clean[1] == ':' {
		drive := strings.ToLower(clean[:1])
		return "", "/mnt/" + drive + strings.ReplaceAll(clean[2:], `\`, "/")
	}
	return "", filepath.ToSlash(p)
}

// Command builds a non-interactive command that runs `name args...` in dir.
// For WSL it goes through a login shell so the user's PATH (nvm, ~/.local/bin) applies.
func Command(ctx context.Context, env Env, dir, name string, args ...string) *exec.Cmd {
	var cmd *exec.Cmd
	if env.Normalize() == EnvWSL {
		cmd = exec.CommandContext(ctx, "wsl.exe", wslArgs(dir, name, args...)...)
	} else {
		cmd = exec.CommandContext(ctx, name, args...)
		cmd.Dir = dir
	}
	hideWindow(cmd)
	return cmd
}

// DirectCommand runs a system binary (e.g. git) without a login shell. Use it when
// the output is parsed, so shell startup output can't get mixed in.
func DirectCommand(ctx context.Context, env Env, dir, name string, args ...string) *exec.Cmd {
	var cmd *exec.Cmd
	if env.Normalize() == EnvWSL {
		distro, linuxDir := ToWSLPath(dir)
		wargs := []string{}
		if distro != "" {
			wargs = append(wargs, "-d", distro)
		}
		wargs = append(wargs, "--cd", linuxDir, "-e", name)
		cmd = exec.CommandContext(ctx, "wsl.exe", append(wargs, args...)...)
	} else {
		cmd = exec.CommandContext(ctx, name, args...)
		cmd.Dir = dir
	}
	hideWindow(cmd)
	return cmd
}

// wslArgs builds `wsl.exe` arguments; `exec "$0" "$@"` passes args without re-quoting.
func wslArgs(dir, name string, args ...string) []string {
	distro, linuxDir := ToWSLPath(dir)
	out := []string{}
	if distro != "" {
		out = append(out, "-d", distro)
	}
	out = append(out, "--cd", linuxDir, "-e", "bash", "-lic", `exec "$0" "$@"`, name)
	return append(out, args...)
}

// ShellCommand returns the interactive shell to launch in a terminal.
func ShellCommand(env Env, dir string) (name string, args []string) {
	if env.Normalize() == EnvWSL {
		distro, linuxDir := ToWSLPath(dir)
		args = []string{}
		if distro != "" {
			args = append(args, "-d", distro)
		}
		return "wsl.exe", append(args, "--cd", linuxDir)
	}
	if IsWindows() {
		if p, err := exec.LookPath("pwsh.exe"); err == nil {
			return p, []string{"-NoLogo"}
		}
		return "powershell.exe", []string{"-NoLogo"}
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh, []string{"-l"}
	}
	return "/bin/sh", nil
}

// SetEnv sets an environment variable for cmd (on top of this process's environment when
// cmd has none yet), as AddEnv does.
func SetEnv(cmd *exec.Cmd, env Env, key, value string, isPath bool) {
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Env = AddEnv(cmd.Env, env, key, value, isPath)
}

// AddEnv adds key=value to an environment. For WSL the key is also named in WSLENV so it
// crosses into the distro; isPath translates a Windows path to its /mnt/... form on the way.
func AddEnv(vars []string, env Env, key, value string, isPath bool) []string {
	vars = append(vars, key+"="+value)
	if env.Normalize() != EnvWSL {
		return vars
	}
	flag := "/u"
	if isPath {
		flag = "/p"
	}
	wslenv := ""
	for _, kv := range vars {
		if len(kv) > 7 && strings.EqualFold(kv[:7], "WSLENV=") {
			wslenv = kv[7:]
		}
	}
	if wslenv != "" {
		wslenv += ":"
	}
	return append(vars, "WSLENV="+wslenv+key+flag)
}
