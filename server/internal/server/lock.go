package server

import (
	"errors"
	"os"
	"path/filepath"
)

// ErrLocked means another server already holds the data directory.
var ErrLocked = errors.New("another harness server is running for this data directory")

// Lock holds the data directory for this server. The OS releases it when the process exits,
// even after a crash, so a stale lock can never keep a new server from starting.
type Lock struct{ f *os.File }

// AcquireLock takes the data directory's server lock without waiting. It returns ErrLocked
// when another server (running or still starting) holds it.
func AcquireLock(dataDir string) (*Lock, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dataDir, "server.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Release gives the lock up (it is also released when the process exits).
func (l *Lock) Release() {
	if l != nil && l.f != nil {
		_ = unlockFile(l.f)
		_ = l.f.Close()
		l.f = nil
	}
}
