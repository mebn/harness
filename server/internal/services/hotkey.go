package services

import (
	"errors"
	"log"
	"strings"
	"sync"

	"harness/server/internal/hotkey"
	"harness/server/internal/store"
)

const hotkeyKey = "hotkey"

// HotkeyInfo is the system-wide shortcut that opens the quick chat.
type HotkeyInfo struct {
	// Spec as saved: "mod mod" (double tap), "ctrl+shift+space" (combination) or "off".
	Spec string `json:"spec"`
	// How it's shown, e.g. "Ctrl Ctrl" or "⌘⇧Space"; empty when off.
	Label string `json:"label"`
	// Why it isn't working, if it isn't.
	Error string `json:"error"`
	// macOS: the System Settings pane that grants Input Monitoring (needed for double taps).
	SettingsURL string `json:"settingsUrl"`
}

// Shortcuts registers key combinations system-wide (Wails' GlobalShortcutManager).
type Shortcuts interface {
	Register(accelerator string, callback func()) error
	Unregister(accelerator string) error
}

// HotkeyService owns the quick chat's system-wide shortcut. It lives in the server, which
// keeps running when windows close, so the shortcut works whenever Harness is running.
type HotkeyService struct {
	store *store.Store

	mu        sync.Mutex
	spec      string
	shortcuts Shortcuts
	open      func()
	accel     string // the combination registered now, if any
	err       error
}

func NewHotkeyService(s *store.Store) *HotkeyService {
	h := &HotkeyService{store: s, spec: hotkey.Default}
	var saved string
	if err := s.GetJSON(hotkeyKey, &saved); err == nil && saved != "" {
		h.spec = saved
	}
	return h
}

// StartHotkey starts listening; open runs on each press. Call once the app runs. A plain
// function rather than a method so it isn't exposed to the frontend.
func StartHotkey(h *HotkeyService, shortcuts Shortcuts, open func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.shortcuts, h.open = shortcuts, open
	h.apply()
}

// Get returns the shortcut and whether it works.
func (h *HotkeyService) Get() HotkeyInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.info()
}

// Set changes the shortcut: "mod mod", "alt alt", ... for a double tap, "ctrl+shift+space"
// and the like for a combination, or "off".
func (h *HotkeyService) Set(spec string) (HotkeyInfo, error) {
	spec = strings.ToLower(strings.TrimSpace(spec))
	if spec == "" {
		spec = hotkey.Default
	}
	if _, err := hotkey.Parse(spec); err != nil {
		return HotkeyInfo{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.store.SetJSON(hotkeyKey, spec); err != nil {
		return HotkeyInfo{}, err
	}
	h.spec = spec
	if h.shortcuts != nil {
		h.apply()
	}
	return h.info(), nil
}

func (h *HotkeyService) info() HotkeyInfo {
	info := HotkeyInfo{Spec: h.spec, SettingsURL: hotkey.SettingsURL}
	if spec, err := hotkey.Parse(h.spec); err == nil {
		info.Label = spec.Label
	}
	err := h.err
	if errors.Is(err, hotkey.ErrPermission) && hotkey.Active() {
		err = nil // granted since
	}
	if err != nil {
		info.Error = err.Error()
	}
	return info
}

// apply drops the previous shortcut and starts the current one. Called with h.mu held.
func (h *HotkeyService) apply() {
	hotkey.Unwatch()
	if h.accel != "" {
		_ = h.shortcuts.Unregister(h.accel)
		h.accel = ""
	}
	h.err = nil

	spec, err := hotkey.Parse(h.spec)
	if err != nil {
		h.err = err
		return
	}
	open := h.open
	fire := func() { go open() }
	switch {
	case spec.Off:
	case spec.DoubleTap:
		h.err = hotkey.Watch(spec.Modifier, fire)
	default:
		if err := h.shortcuts.Register(spec.Accelerator, fire); err != nil {
			h.err = err
		} else {
			h.accel = spec.Accelerator
		}
	}
	if h.err != nil {
		log.Printf("hotkey %q: %v", h.spec, h.err)
	}
}
