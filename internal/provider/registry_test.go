package provider

import "testing"

func TestRegistryAccounts(t *testing.T) {
	r := NewRegistry(Claude{}, NewCodex(""))
	if infos := r.Infos(); len(infos) != 2 || infos[0].AccountNo != 0 {
		t.Fatalf("without accounts: %+v", infos)
	}
	r.SetAccounts([]Account{{ID: "a1", Tool: "claude", Label: "work@x.y", Dir: "/tmp/a1"}},
		map[string]string{"claude": "me@x.y"})
	infos := r.Infos()
	want := []struct {
		id, account string
		no          int
	}{{"claude", "me@x.y", 1}, {"claude@a1", "work@x.y", 2}, {"codex", "", 0}}
	if len(infos) != len(want) {
		t.Fatalf("got %d providers, want %d", len(infos), len(want))
	}
	for i, w := range want {
		if infos[i].ID != w.id || infos[i].Account != w.account || infos[i].AccountNo != w.no || infos[i].Tool == "" {
			t.Errorf("provider %d = %s %q #%d (tool %q); want %s %q #%d", i, infos[i].ID, infos[i].Account, infos[i].AccountNo, infos[i].Tool, w.id, w.account, w.no)
		}
	}
	if _, ok := r.Get("claude@a1"); !ok {
		t.Error("account provider not found")
	}
}
