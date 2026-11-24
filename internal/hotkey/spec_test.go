package hotkey

import (
	"runtime"
	"testing"
)

func TestParse(t *testing.T) {
	mod, modAccel := Ctrl, "ctrl"
	if runtime.GOOS == "darwin" {
		mod, modAccel = Cmd, "cmd"
	}

	for _, tt := range []struct {
		in        string
		doubleTap bool
		modifier  Modifier
		accel     string
	}{
		{"", true, mod, ""},
		{"mod mod", true, mod, ""},
		{"Shift Shift", true, Shift, ""},
		{"option option", true, Alt, ""},
		{"mod+space", false, 0, modAccel + "+space"},
		{"ctrl + alt + k", false, 0, "ctrl+alt+k"},
		{"mod+shift+g", false, 0, modAccel + "+shift+g"},
	} {
		got, err := Parse(tt.in)
		if err != nil {
			t.Errorf("Parse(%q): %v", tt.in, err)
			continue
		}
		if got.DoubleTap != tt.doubleTap || (tt.doubleTap && got.Modifier != tt.modifier) || got.Accelerator != tt.accel {
			t.Errorf("Parse(%q) = %+v", tt.in, got)
		}
		if got.Label == "" {
			t.Errorf("Parse(%q) has no label", tt.in)
		}
	}

	for _, bad := range []string{"cmd shift", "mod", "space", "mod+", "hyper+k", "mod+shift"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("Parse(%q) should fail", bad)
		}
	}
}

func TestParseOffAndNamedKeys(t *testing.T) {
	if s, err := Parse("off"); err != nil || !s.Off {
		t.Fatalf("Parse(off) = %+v, %v", s, err)
	}
	s, err := Parse("ctrl+page up")
	if err != nil || s.Accelerator != "ctrl+page up" || s.Label == "" {
		t.Fatalf("Parse(ctrl+page up) = %+v, %v", s, err)
	}
}
