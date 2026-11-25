package services

import "testing"

func TestParseVersion(t *testing.T) {
	cases := []struct{ out, version, latest string }{
		{"2.1.331 (Claude Code)\n", "2.1.331", ""},
		{"codex-cli 0.153.0\n", "0.153.0", ""},
		{"GitHub Copilot CLI 1.0.114.\n\nUpdate available: 1.0.115\n", "1.0.114", "1.0.115"},
		{"", "", ""},
	}
	for _, c := range cases {
		v, l := parseVersion(c.out)
		if v != c.version || l != c.latest {
			t.Errorf("parseVersion(%q) = %q, %q; want %q, %q", c.out, v, l, c.version, c.latest)
		}
	}
}

func TestParseStatus(t *testing.T) {
	cases := []struct {
		tool, out       string
		failed          bool
		signed, account string
	}{
		{"claude", `{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c"}`, false, "yes", "a@b.c · claude.ai"},
		{"claude", `{"loggedIn": false}`, true, "no", ""},
		{"claude", "", true, "", ""},
		{"codex", "Logged in using ChatGPT\n", false, "yes", "ChatGPT"},
		{"codex", "Not logged in\n", true, "no", ""},
		{"copilot", `// comment` + "\n" + `{"logged_in_users": [{"host": "https://github.com", "login": "octo"}]}`, false, "yes", "octo"},
		{"copilot", `{}`, false, "no", ""},
		{"copilot", "", false, "", ""},
	}
	for _, c := range cases {
		s, a := parseStatus(c.tool, c.out, c.failed)
		if s != c.signed || a != c.account {
			t.Errorf("parseStatus(%s, %q) = %q, %q; want %q, %q", c.tool, c.out, s, a, c.signed, c.account)
		}
	}
}

func TestParseWSL(t *testing.T) {
	out := "Welcome to Ubuntu\r\n@@distro Ubuntu\n" +
		"@@path claude /home/u/.local/bin/claude\n" +
		"@@version claude 2.1.332 (Claude Code)\x1e\n" +
		`@@status claude 0 { "loggedIn": true, "authMethod": "claude.ai" }` + "\n" +
		"@@missing codex\n" +
		"@@path copilot /home/u/.npm/bin/copilot\n" +
		"@@version copilot GitHub Copilot CLI 1.0.114.\x1e\x1eUpdate available: 1.0.115\x1e\n" +
		"@@status copilot 0 \n"
	list := parseWSL(out)
	if len(list) != 3 {
		t.Fatalf("got %d installs", len(list))
	}
	byTool := map[string]AgentInstall{}
	for _, in := range list {
		byTool[in.Tool] = in
		if in.Place != "WSL (Ubuntu)" || in.Env != "wsl" {
			t.Errorf("%s: place %q env %q", in.Tool, in.Place, in.Env)
		}
	}
	if c := byTool["claude"]; !c.Installed || c.Version != "2.1.332" || c.SignedIn != "yes" || c.Account != "claude.ai" {
		t.Errorf("claude: %+v", c)
	}
	if c := byTool["codex"]; c.Installed {
		t.Errorf("codex should be missing: %+v", c)
	}
	if c := byTool["copilot"]; !c.Installed || c.Version != "1.0.114" || c.Latest != "1.0.115" || c.SignedIn != "" {
		t.Errorf("copilot: %+v", c)
	}
}
