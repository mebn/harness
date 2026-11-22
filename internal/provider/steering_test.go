package provider

import "testing"

// feed runs Claude stream-json lines through the same handling Claude.Run uses.
func feed(s *Steering, lines ...string) []Event {
	var out []Event
	for _, l := range lines {
		parseClaudeLine([]byte(l), func(e Event) {
			switch e.Kind {
			case eventInputTaken:
				if id, ok := s.taken(); ok && id != "" {
					out = append(out, Event{Kind: EventSteered, InputID: id})
				}
			case eventTurnEnd:
				s.turnEnded()
			default:
				out = append(out, e)
			}
		})
	}
	return out
}

func TestSteeringMidTurn(t *testing.T) {
	s := NewSteering()
	var written []string
	closed := false
	s.open(Input{Prompt: "first"}, func(in Input) error { written = append(written, in.Prompt); return nil }, func() { closed = true })

	replay := `{"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"x"}]}}`
	feed(s, replay) // the opening prompt
	if !s.Send(Input{ID: "q1", Prompt: "steer"}) {
		t.Fatal("send refused while running")
	}
	ev := feed(s, replay)
	if len(ev) != 1 || ev[0].Kind != EventSteered || ev[0].InputID != "q1" {
		t.Fatalf("events: %+v", ev)
	}
	feed(s, `{"type":"result","result":"ok"}`)
	if !closed {
		t.Fatal("input not closed after the last message was answered")
	}
	if s.Send(Input{ID: "q2"}) {
		t.Fatal("send accepted after the turn ended")
	}
	if len(written) != 2 {
		t.Fatalf("written: %v", written)
	}
}

func TestSteeringAfterLastToolKeepsInputOpen(t *testing.T) {
	s := NewSteering()
	closed := false
	s.open(Input{Prompt: "first"}, func(Input) error { return nil }, func() { closed = true })
	replay := `{"type":"user","isReplay":true,"message":{"role":"user","content":[]}}`
	feed(s, replay)
	s.Send(Input{ID: "late"})
	// The turn ends before the agent takes the message in: it starts another round.
	feed(s, `{"type":"result","result":"ok"}`)
	if closed {
		t.Fatal("closed with a message still waiting")
	}
	feed(s, replay, `{"type":"result","result":"ok"}`)
	if !closed {
		t.Fatal("not closed after the second round")
	}
}

func TestSteeringWithoutReplayStillCloses(t *testing.T) {
	s := NewSteering()
	closed := false
	s.open(Input{Prompt: "first"}, func(Input) error { return nil }, func() { closed = true })
	feed(s, `{"type":"result","result":"ok"}`)
	if !closed {
		t.Fatal("waited for an echo the CLI never sends")
	}
}

func TestSteeringUnsupported(t *testing.T) {
	var s *Steering
	if s.Send(Input{}) || NewSteering().Send(Input{}) {
		t.Fatal("send accepted by a provider that never opened steering")
	}
}
