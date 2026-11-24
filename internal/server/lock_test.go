package server

import (
	"errors"
	"testing"
)

// Only one server may hold a data directory; the next one in line gets it once it's released.
func TestLockIsExclusive(t *testing.T) {
	dir := t.TempDir()
	first, err := AcquireLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireLock(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("second lock: got %v, want ErrLocked", err)
	}
	first.Release()
	second, err := AcquireLock(dir)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	second.Release()
}
