package services

import (
	"encoding/base64"
	"testing"
)

func TestCodexEmail(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"a@b.c"}`))
	auth := `{"tokens":{"id_token":"x.` + payload + `.sig"}}`
	if got := codexEmail(auth); got != "a@b.c" {
		t.Errorf("codexEmail = %q", got)
	}
	if got := codexEmail(`{"OPENAI_API_KEY":"sk"}`); got != "" {
		t.Errorf("codexEmail with an API key = %q", got)
	}
}
