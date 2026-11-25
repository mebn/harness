package platform

import "testing"

func TestToWSLPath(t *testing.T) {
	cases := []struct{ in, distro, path string }{
		{`C:\Users\me\proj`, "", "/mnt/c/Users/me/proj"},
		{`\\wsl.localhost\Ubuntu\home\me\proj`, "Ubuntu", "/home/me/proj"},
		{`\\wsl$\Debian\srv`, "Debian", "/srv"},
		{`\\wsl.localhost\Ubuntu`, "Ubuntu", "/"},
	}
	for _, c := range cases {
		d, p := ToWSLPath(c.in)
		if d != c.distro || p != c.path {
			t.Errorf("ToWSLPath(%q) = %q, %q; want %q, %q", c.in, d, p, c.distro, c.path)
		}
	}
}

func TestEnvForPath(t *testing.T) {
	if got := EnvForPath(`C:\code\app`); got != EnvNative {
		t.Errorf("windows path: got %q", got)
	}
	if HasWSL() {
		if got := EnvForPath(`\\wsl.localhost\Ubuntu\home\me\app`); got != EnvWSL {
			t.Errorf("wsl path: got %q", got)
		}
	}
}

func TestAddEnvNative(t *testing.T) {
	got := AddEnv([]string{"A=1"}, EnvNative, "B", `C:\x`, true)
	if len(got) != 2 || got[1] != `B=C:\x` {
		t.Errorf("AddEnv = %v", got)
	}
}
