package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"harness/internal/platform"
	"harness/internal/provider"
	"harness/internal/store"
)

// agentCLI is an agent CLI Harness can find, update and sign in to.
type agentCLI struct {
	ID, Name string
	Update   []string // arguments that update it in place
	Login    []string // arguments that sign in (interactive)
	// Status returns arguments that print the sign-in state, or nil when the CLI has none.
	Status []string
}

var agentCLIs = []agentCLI{
	{ID: "claude", Name: "Claude Code", Update: []string{"update"}, Login: []string{"auth", "login"}, Status: []string{"auth", "status", "--json"}},
	{ID: "codex", Name: "Codex", Update: []string{"update"}, Login: []string{"login"}, Status: []string{"login", "status"}},
	// Copilot has no status command; its config file names the signed-in user.
	{ID: "copilot", Name: "GitHub Copilot", Update: []string{"update"}, Login: []string{"login"}},
}

func findCLI(id string) (agentCLI, bool) {
	for _, c := range agentCLIs {
		if c.ID == id {
			return c, true
		}
	}
	return agentCLI{}, false
}

// AgentInstall is one agent CLI in one place it can run: natively or in WSL.
type AgentInstall struct {
	Tool string `json:"tool"`
	Name string `json:"name"`
	Env  string `json:"env"` // "native" | "wsl"
	// Place names where it runs: "Windows", "macOS", "Linux" or "WSL (Ubuntu)".
	Place     string `json:"place"`
	Installed bool   `json:"installed"`
	Path      string `json:"path"`
	Version   string `json:"version"`
	// Latest is a newer version the CLI reported, when it says so.
	Latest string `json:"latest"`
	// SignedIn is "yes", "no" or "" (unknown); Account describes how or as whom.
	SignedIn string `json:"signedIn"`
	Account  string `json:"account"`
	Error    string `json:"error"`
}

// NewChatDefaults is what new chats start with. An empty Provider means "like the last chat".
type NewChatDefaults struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Effort   string `json:"effort"`
}

const newChatDefaultsKey = "newChatDefaults"

// AgentService finds the agent CLIs installed natively and in WSL, updates them and signs in
// (in a terminal, as those are interactive), and keeps the defaults for new chats.
type AgentService struct {
	store     *store.Store
	providers *provider.Registry
	terms     *TerminalService
}

func NewAgentService(s *store.Store, r *provider.Registry, terms *TerminalService) *AgentService {
	return &AgentService{store: s, providers: r, terms: terms}
}

// Installs looks for every agent CLI natively and, on Windows, in WSL's default distro.
func (a *AgentService) Installs() []AgentInstall {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		out  = make([]AgentInstall, len(agentCLIs))
		wsl  []AgentInstall
		werr error
	)
	for i, c := range agentCLIs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = nativeInstall(ctx, c)
		}()
	}
	if platform.HasWSL() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			list, err := wslInstalls(ctx)
			mu.Lock()
			wsl, werr = list, err
			mu.Unlock()
		}()
	}
	wg.Wait()
	if platform.HasWSL() {
		if werr != nil {
			for _, c := range agentCLIs {
				wsl = append(wsl, AgentInstall{Tool: c.ID, Name: c.Name, Env: string(platform.EnvWSL), Place: "WSL", Error: werr.Error()})
			}
		}
		out = append(out, wsl...)
	}
	return out
}

// Run starts the CLI's update or login command in a terminal and returns the terminal's id,
// which works with TerminalService's Write, Resize and Close. Its output streams as term:data
// and term:exit tells when it's done.
func (a *AgentService) Run(tool, env, action string, cols, rows int) (string, error) {
	c, ok := findCLI(tool)
	if !ok {
		return "", errors.New("unknown agent CLI: " + tool)
	}
	var args []string
	switch action {
	case "update":
		args = c.Update
	case "login":
		args = c.Login
	default:
		return "", errors.New("unknown action: " + action)
	}
	e := platform.EnvNative
	if env == string(platform.EnvWSL) {
		if !platform.HasWSL() {
			return "", errors.New("WSL isn't available")
		}
		e = platform.EnvWSL
	}
	return a.terms.startCommand(e, c.ID, args, cols, rows)
}

// NewChatDefaults returns what new chats start with.
func (a *AgentService) NewChatDefaults() NewChatDefaults {
	return loadNewChatDefaults(a.store, a.providers)
}

// SetNewChatDefaults saves what new chats start with; an empty provider means "like the last chat".
func (a *AgentService) SetNewChatDefaults(d NewChatDefaults) (NewChatDefaults, error) {
	if d.Provider != "" {
		p, ok := a.providers.Get(d.Provider)
		if !ok {
			return d, errors.New("unknown provider: " + d.Provider)
		}
		info := p.Info()
		if !hasOption(info.Models, d.Model) {
			d.Model = info.DefaultModel
		}
		if !hasOption(info.Efforts, d.Effort) {
			d.Effort = info.DefaultEffort
		}
	} else {
		d = NewChatDefaults{}
	}
	return d, a.store.SetJSON(newChatDefaultsKey, d)
}

// loadNewChatDefaults reads the saved defaults, dropping a provider that no longer exists.
func loadNewChatDefaults(s *store.Store, r *provider.Registry) NewChatDefaults {
	var d NewChatDefaults
	if err := s.GetJSON(newChatDefaultsKey, &d); err != nil || d.Provider == "" {
		return NewChatDefaults{}
	}
	if _, ok := r.Get(d.Provider); !ok {
		return NewChatDefaults{}
	}
	return d
}

// ---- detection ----

var versionRe = regexp.MustCompile(`\d+\.\d+\.\d+[\w.-]*`)

// parseVersion reads `--version` output: the first version is the installed one, and a line
// like Copilot's "Update available: 1.0.115" names a newer one.
func parseVersion(out string) (version, latest string) {
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		v := strings.TrimSuffix(versionRe.FindString(line), ".")
		if v == "" {
			continue
		}
		if version == "" {
			version = v
		} else if strings.Contains(strings.ToLower(line), "available") {
			latest = v
		}
	}
	return version, latest
}

// parseStatus reads a CLI's sign-in state from its status command (or, for Copilot, its config).
func parseStatus(tool, out string, exitErr bool) (signedIn, account string) {
	out = strings.TrimSpace(out)
	switch tool {
	case "claude":
		var st struct {
			LoggedIn   bool   `json:"loggedIn"`
			AuthMethod string `json:"authMethod"`
			Email      string `json:"email"`
		}
		if i := strings.Index(out, "{"); i >= 0 && json.Unmarshal([]byte(out[i:]), &st) == nil {
			if !st.LoggedIn {
				return "no", ""
			}
			return "yes", strings.TrimSpace(strings.Join(nonEmpty(st.Email, st.AuthMethod), " · "))
		}
	case "codex":
		if out == "" {
			return "", ""
		}
		low := strings.ToLower(out)
		if exitErr || strings.Contains(low, "not logged in") {
			return "no", ""
		}
		if after, ok := strings.CutPrefix(out, "Logged in using "); ok {
			return "yes", strings.TrimSpace(strings.SplitN(after, "\n", 2)[0])
		}
		return "yes", ""
	case "copilot":
		if m := copilotLoginRe.FindStringSubmatch(out); m != nil {
			return "yes", m[1]
		}
		if out != "" {
			return "no", ""
		}
	}
	return "", ""
}

var copilotLoginRe = regexp.MustCompile(`"login"\s*:\s*"([^"]+)"`)

func nonEmpty(xs ...string) []string {
	var out []string
	for _, x := range xs {
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

func nativePlace() string {
	switch runtime.GOOS {
	case "windows":
		return "Windows"
	case "darwin":
		return "macOS"
	}
	return "Linux"
}

// nativeInstall finds one CLI on this machine's PATH and asks it for its version and sign-in.
func nativeInstall(ctx context.Context, c agentCLI) AgentInstall {
	in := AgentInstall{Tool: c.ID, Name: c.Name, Env: string(platform.EnvNative), Place: nativePlace()}
	path, err := exec.LookPath(c.ID)
	if err != nil {
		return in
	}
	in.Installed, in.Path = true, path
	run := func(args ...string) (string, bool) {
		cmd := platform.DirectCommand(ctx, platform.EnvNative, "", path, args...)
		out, err := cmd.CombinedOutput()
		return string(out), err != nil
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		out, _ := run("--version")
		in.Version, in.Latest = parseVersion(out)
	}()
	go func() {
		defer wg.Done()
		if c.Status != nil {
			out, failed := run(c.Status...)
			in.SignedIn, in.Account = parseStatus(c.ID, out, failed)
		} else if c.ID == "copilot" {
			home, _ := os.UserHomeDir()
			data, _ := os.ReadFile(filepath.Join(home, ".copilot", "config.json"))
			in.SignedIn, in.Account = parseStatus(c.ID, string(data), false)
		}
	}()
	wg.Wait()
	return in
}

// wslScript prints, for each CLI, marker lines that survive whatever the login shell prints
// first (a message of the day, nvm notices). CLIs found under /mnt are Windows ones reached
// through interop, not installs in the distro.
const wslScript = `
echo "@@distro $WSL_DISTRO_NAME"
for t in claude codex copilot; do
  p=$(command -v "$t" 2>/dev/null)
  case "$p" in /mnt/*|"") echo "@@missing $t"; continue;; esac
  echo "@@path $t $p"
  echo "@@version $t $("$p" --version 2>/dev/null | head -n 3 | tr '\n' '\036')"
  case "$t" in
    claude) s=$("$p" auth status --json 2>/dev/null); rc=$?;;
    codex) s=$("$p" login status 2>&1); rc=$?;;
    copilot) s=$(cat "$HOME/.copilot/config.json" 2>/dev/null); rc=0;;
  esac
  echo "@@status $t $rc $(printf '%s' "$s" | tr '\n' ' ')"
done
`

// wslInstalls finds the CLIs inside WSL's default distro, in one login shell.
func wslInstalls(ctx context.Context) ([]AgentInstall, error) {
	cmd := platform.Command(ctx, platform.EnvWSL, "~", "sh", "-c", wslScript)
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return nil, errors.New("couldn't run a shell in WSL: " + err.Error())
	}
	return parseWSL(string(out)), nil
}

func parseWSL(out string) []AgentInstall {
	place := "WSL"
	byTool := map[string]*AgentInstall{}
	list := make([]AgentInstall, len(agentCLIs))
	for i, c := range agentCLIs {
		list[i] = AgentInstall{Tool: c.ID, Name: c.Name, Env: string(platform.EnvWSL)}
		byTool[c.ID] = &list[i]
	}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		i := strings.Index(line, "@@")
		if i < 0 {
			continue
		}
		kind, rest, _ := strings.Cut(line[i+2:], " ")
		if kind == "distro" {
			if d := strings.TrimSpace(rest); d != "" {
				place = "WSL (" + d + ")"
			}
			continue
		}
		tool, rest, _ := strings.Cut(rest, " ")
		in := byTool[tool]
		if in == nil {
			continue
		}
		switch kind {
		case "path":
			in.Installed, in.Path = true, strings.TrimSpace(rest)
		case "version":
			in.Version, in.Latest = parseVersion(strings.ReplaceAll(rest, "\x1e", "\n"))
		case "status":
			rc, s, _ := strings.Cut(rest, " ")
			in.SignedIn, in.Account = parseStatus(tool, s, rc != "0")
		}
	}
	for i := range list {
		list[i].Place = place
	}
	return list
}
