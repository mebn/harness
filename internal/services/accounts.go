package services

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"harness/internal/platform"
	"harness/internal/provider"
)

// AgentAccount is one account of an agent CLI: the CLI's own sign-in (ID "") or another one
// Harness keeps in a config directory of its own. Each is a provider chats can pick.
type AgentAccount struct {
	ID       string `json:"id"`
	Provider string `json:"provider"` // the provider id chats use
	Tool     string `json:"tool"`
	// No numbers the CLI's accounts from 1 (its own sign-in).
	No    int    `json:"no"`
	Name  string `json:"name"`  // given in Settings
	Email string `json:"email"` // as whom it's signed in (an email or user name), when known
	// SignedIn is "yes", "no" or "" (unknown).
	SignedIn string `json:"signedIn"`
	Dir      string `json:"dir"` // its config directory; "" for the CLI's default
}

// savedAccount is an account as stored; defaults (ID "") keep only their name and email.
type savedAccount struct {
	ID    string `json:"id"`
	Tool  string `json:"tool"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type savedAccounts struct {
	Accounts []savedAccount          `json:"accounts"`
	Defaults map[string]savedAccount `json:"defaults"` // by tool
}

const accountsKey = "accounts"

func (a *AgentService) loadAccounts() savedAccounts {
	var s savedAccounts
	_ = a.store.GetJSON(accountsKey, &s)
	if s.Defaults == nil {
		s.Defaults = map[string]savedAccount{}
	}
	return s
}

// saveAccounts stores the accounts and makes them the providers chats can pick.
func (a *AgentService) saveAccounts(s savedAccounts) error {
	a.applyAccounts(s)
	return a.store.SetJSON(accountsKey, s)
}

func (a *AgentService) applyAccounts(s savedAccounts) {
	accounts := make([]provider.Account, 0, len(s.Accounts))
	for _, x := range s.Accounts {
		accounts = append(accounts, provider.Account{ID: x.ID, Tool: x.Tool, Label: accountLabel(x), Dir: a.accountDir(x.ID)})
	}
	defaults := map[string]string{}
	for tool, x := range s.Defaults {
		defaults[tool] = accountLabel(x)
	}
	a.providers.SetAccounts(accounts, defaults)
}

func accountLabel(x savedAccount) string {
	if x.Name != "" {
		return x.Name
	}
	return x.Email
}

func (a *AgentService) accountDir(id string) string {
	return filepath.Join(a.dataDir, "accounts", id)
}

// Accounts lists every CLI's accounts, its own sign-in first, and checks whom each is
// signed in as.
func (a *AgentService) Accounts() []AgentAccount {
	a.accountsMu.Lock()
	s := a.loadAccounts()
	a.accountsMu.Unlock()

	var out []AgentAccount
	for _, c := range agentCLIs {
		d := s.Defaults[c.ID]
		out = append(out, AgentAccount{Provider: c.ID, Tool: c.ID, No: 1, Name: d.Name, Email: d.Email})
		no := 1
		for _, x := range s.Accounts {
			if x.Tool == c.ID {
				no++
				out = append(out, AgentAccount{ID: x.ID, Provider: provider.Account{ID: x.ID, Tool: x.Tool}.ProviderID(),
					Tool: x.Tool, No: no, Name: x.Name, Email: x.Email, Dir: a.accountDir(x.ID)})
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for i := range out {
		wg.Add(1)
		go func() {
			defer wg.Done()
			signedIn, email := accountStatus(ctx, out[i].Tool, out[i].Dir)
			out[i].SignedIn = signedIn
			if email != "" {
				out[i].Email = email
			}
		}()
	}
	wg.Wait()

	// Remember whom each is signed in as, for the model picker.
	a.accountsMu.Lock()
	defer a.accountsMu.Unlock()
	s = a.loadAccounts()
	changed := false
	for _, x := range out {
		if x.Email == "" {
			continue
		}
		if x.ID == "" {
			d := s.Defaults[x.Tool]
			if d.Email != x.Email {
				d.Email, changed = x.Email, true
				s.Defaults[x.Tool] = d
			}
			continue
		}
		for i := range s.Accounts {
			if s.Accounts[i].ID == x.ID && s.Accounts[i].Email != x.Email {
				s.Accounts[i].Email, changed = x.Email, true
			}
		}
	}
	if changed {
		if err := a.saveAccounts(s); err != nil {
			log.Printf("accounts: %v", err)
		}
	}
	return out
}

// AddAccount adds an account to a CLI, with a config directory of its own. It isn't signed in
// until Run's "login" runs for it.
func (a *AgentService) AddAccount(tool string) (AgentAccount, error) {
	if _, ok := findCLI(tool); !ok {
		return AgentAccount{}, errors.New("unknown agent CLI: " + tool)
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	dir := a.accountDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return AgentAccount{}, err
	}
	a.accountsMu.Lock()
	defer a.accountsMu.Unlock()
	s := a.loadAccounts()
	s.Accounts = append(s.Accounts, savedAccount{ID: id, Tool: tool})
	if err := a.saveAccounts(s); err != nil {
		return AgentAccount{}, err
	}
	no := 1
	for _, x := range s.Accounts {
		if x.Tool == tool {
			no++
		}
	}
	return AgentAccount{ID: id, Provider: provider.Account{ID: id, Tool: tool}.ProviderID(), Tool: tool, No: no, Dir: dir}, nil
}

// RenameAccount names an account ("" goes back to whom it's signed in as). The CLI's own
// sign-in is named with its tool as id.
func (a *AgentService) RenameAccount(tool, id, name string) error {
	name = strings.TrimSpace(name)
	a.accountsMu.Lock()
	defer a.accountsMu.Unlock()
	s := a.loadAccounts()
	if id == "" {
		d := s.Defaults[tool]
		d.Name = name
		s.Defaults[tool] = d
		return a.saveAccounts(s)
	}
	for i := range s.Accounts {
		if s.Accounts[i].ID == id {
			s.Accounts[i].Name = name
			return a.saveAccounts(s)
		}
	}
	return errors.New("no such account")
}

// RemoveAccount forgets an account and deletes its config directory (its sign-in and the
// CLI's history for it). Chats that used it move to the CLI's own sign-in, in a new
// conversation (the old one was kept in that directory).
func (a *AgentService) RemoveAccount(id string) error {
	if id == "" {
		return errors.New("the CLI's own sign-in can't be removed")
	}
	a.accountsMu.Lock()
	s := a.loadAccounts()
	kept := s.Accounts[:0:0]
	var removed provider.Account
	for _, x := range s.Accounts {
		if x.ID != id {
			kept = append(kept, x)
		} else {
			removed = provider.Account{ID: x.ID, Tool: x.Tool}
		}
	}
	if removed.ID == "" {
		a.accountsMu.Unlock()
		return errors.New("no such account")
	}
	s.Accounts = kept
	err := a.saveAccounts(s)
	a.accountsMu.Unlock()
	if err != nil {
		return err
	}
	if sessions, err := a.store.SessionsWithProvider(removed.ProviderID()); err == nil {
		for _, sess := range sessions {
			sess.Provider, sess.ProviderSessionID, sess.Started = removed.Tool, uuid.NewString(), false
			sess.ForkFrom, sess.ResumeAt, sess.LastUUID = "", "", ""
			if err := a.store.UpdateSession(&sess); err != nil {
				log.Printf("accounts: moving chat %s: %v", sess.ID, err)
			}
		}
	}
	if err := os.RemoveAll(a.accountDir(id)); err != nil {
		log.Printf("accounts: removing %s: %v", id, err)
	}
	return nil
}

// accountEnv is where an account's CLI runs to sign in and report it: natively when it's
// installed, otherwise in WSL. An account's directory is shared by both.
func accountEnv(tool string) platform.Env {
	if _, err := exec.LookPath(tool); err != nil && platform.HasWSL() {
		return platform.EnvWSL
	}
	return platform.EnvNative
}

// accountVars is the environment that runs a CLI as the account in dir ("" = its default).
func accountVars(base []string, env platform.Env, tool, dir string) []string {
	if dir == "" {
		return base
	}
	if base == nil {
		base = os.Environ()
	}
	return platform.AddEnv(base, env, provider.ConfigDirVar(tool), dir, true)
}

// accountStatus asks a CLI whether the account in dir ("" = its default) is signed in, and
// as whom.
func accountStatus(ctx context.Context, tool, dir string) (signedIn, email string) {
	env := accountEnv(tool)
	c, _ := findCLI(tool)
	var out string
	failed := false
	switch {
	case c.Status != nil:
		name := tool
		if env == platform.EnvNative {
			p, err := exec.LookPath(tool)
			if err != nil {
				return "", ""
			}
			name = p
		}
		var cmd *exec.Cmd
		if env == platform.EnvWSL {
			cmd = platform.Command(ctx, env, "~", name, c.Status...)
		} else {
			cmd = platform.DirectCommand(ctx, env, "", name, c.Status...)
		}
		cmd.Env = accountVars(nil, env, tool, dir)
		b, err := cmd.CombinedOutput()
		out, failed = string(b), err != nil
	case tool == "copilot":
		out = readConfig(env, dir, ".copilot", "config.json")
	}
	signedIn, account := parseStatus(tool, out, failed)
	if signedIn != "yes" {
		return signedIn, ""
	}
	switch tool {
	case "claude":
		// "email · method"; only an email names the account.
		if first, _, _ := strings.Cut(account, " · "); strings.Contains(first, "@") {
			email = first
		}
	case "codex":
		email = codexEmail(readConfig(env, dir, ".codex", "auth.json"))
	case "copilot":
		email = account
	}
	return signedIn, email
}

// readConfig reads a file in a CLI's config directory: dir, or the default one in the home
// folder (in WSL's when env is WSL).
func readConfig(env platform.Env, dir, home, name string) string {
	if dir != "" {
		b, _ := os.ReadFile(filepath.Join(dir, name))
		return string(b)
	}
	if env == platform.EnvWSL {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		b, _ := platform.DirectCommand(ctx, env, "~", "sh", "-c", `cat "$HOME/`+home+`/`+name+`" 2>/dev/null`).Output()
		return string(b)
	}
	h, _ := os.UserHomeDir()
	b, _ := os.ReadFile(filepath.Join(h, home, name))
	return string(b)
}

// codexEmail reads the email from the id token in Codex's auth.json, when signed in with ChatGPT.
func codexEmail(authJSON string) string {
	var auth struct {
		Tokens struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal([]byte(authJSON), &auth) != nil {
		return ""
	}
	parts := strings.Split(auth.Tokens.IDToken, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.Email
}
