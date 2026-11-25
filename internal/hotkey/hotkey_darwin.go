package hotkey

/*
#cgo CFLAGS: -Wno-unguarded-availability-new
#cgo LDFLAGS: -framework ApplicationServices -framework CoreFoundation
#include "hotkey_darwin.h"
*/
import "C"

import (
	"errors"
	"sync"
	"time"
)

// ErrPermission means Input Monitoring hasn't been granted yet. The tap is installed as soon as
// it is, without a restart.
var ErrPermission = errors.New("Harness needs Input Monitoring to detect a double tap. Allow Harness Server in System Settings → Privacy & Security → Input Monitoring")

// SettingsURL opens the system settings pane where the permission is granted.
const SettingsURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"

var (
	tapMu      sync.Mutex
	tapOn      bool
	waiting    bool
	targetDown bool
)

// Virtual keycodes (left, right) and event flag masks for each modifier.
var (
	modKeycodes = map[Modifier][2]C.int{Cmd: {55, 54}, Shift: {56, 60}, Alt: {58, 61}, Ctrl: {59, 62}}
	modFlags    = map[Modifier]uint64{Cmd: 0x100000, Shift: 0x20000, Alt: 0x80000, Ctrl: 0x40000}
)

// allFlags covers every modifier, plus Caps Lock (0x10000) and Fn (0x800000).
const allFlags = 0x100000 | 0x20000 | 0x80000 | 0x40000 | 0x10000 | 0x800000

//export goKeyDown
func goKeyDown() {
	if d, _ := current(); d != nil {
		d.other()
	}
}

//export goFlagsChanged
func goFlagsChanged(keycode C.int, flags C.ulonglong) {
	d, target := current()
	if d == nil {
		targetDown = false
		return
	}
	mask := modFlags[target]
	down := uint64(flags)&mask != 0
	codes := modKeycodes[target]
	isTarget := keycode == codes[0] || keycode == codes[1]
	others := uint64(flags) & (allFlags &^ mask)

	switch {
	case !isTarget || others != 0:
		d.other()
	case down && !targetDown:
		d.modDown(time.Now())
	case !down && targetDown:
		d.modUp(time.Now())
	}
	targetDown = down
}

// Watch makes a double tap of mod call fire, replacing any earlier watch. Call it once the
// app's main run loop exists.
//
// Without Input Monitoring it shows the system prompt and returns ErrPermission; the tap is
// installed in the background once the user allows it.
func Watch(mod Modifier, fire func()) error {
	setWatch(newDetector(fire), mod)
	tapMu.Lock()
	defer tapMu.Unlock()
	if tapOn {
		return nil
	}
	if C.harnessHasAccess() && C.harnessStartTap() {
		tapOn = true
		return nil
	}
	if C.harnessHasAccess() {
		return errors.New("could not create a keyboard event tap")
	}
	if !waiting {
		waiting = true
		C.harnessRequestAccess()
		go func() {
			for range time.Tick(time.Second) {
				tapMu.Lock()
				if C.harnessHasAccess() && C.harnessStartTap() {
					tapOn, waiting = true, false
					tapMu.Unlock()
					return
				}
				tapMu.Unlock()
			}
		}()
	}
	return ErrPermission
}

// Active reports whether double taps are being detected.
func Active() bool {
	tapMu.Lock()
	defer tapMu.Unlock()
	return tapOn
}
