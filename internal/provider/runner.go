package provider

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
)

// lineParser turns one stdout line into zero or more events.
type lineParser func(line []byte, emit func(Event))

// runJSONL starts cmd, feeds stdin, parses stdout line by line and closes the
// channel when the process exits. A failing exit becomes an EventError.
func runJSONL(ctx context.Context, cmd *exec.Cmd, stdin string, parse lineParser) (<-chan Event, error) {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr tailBuffer
	cmd.Stderr = &stderr
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", cmd.Path, err)
	}

	events := make(chan Event, 64)
	go func() {
		defer close(events)
		emit := func(e Event) {
			select {
			case events <- e:
			case <-ctx.Done():
			}
		}
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 1<<20), 32<<20)
		for sc.Scan() {
			line := bytes.TrimSpace(sc.Bytes())
			if len(line) > 0 && line[0] == '{' {
				parse(line, emit)
			}
		}
		_, _ = io.Copy(io.Discard, stdout)
		err := cmd.Wait()
		if err != nil && ctx.Err() == nil {
			msg := strings.TrimSpace(stderr.String())
			var exitErr *exec.ExitError
			if msg == "" || !errors.As(err, &exitErr) {
				msg = strings.TrimSpace(err.Error() + "\n" + msg)
			}
			emit(Event{Kind: EventError, Text: msg})
		}
	}()
	return events, nil
}

// tailBuffer keeps the last 8KB written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 8192 {
		t.buf = t.buf[len(t.buf)-8192:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
