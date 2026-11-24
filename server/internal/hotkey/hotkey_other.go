//go:build !darwin && !windows

package hotkey

import "errors"

// ErrPermission is unused on unsupported platforms.
var ErrPermission = errors.New("permission denied")

// SettingsURL is empty on unsupported platforms.
const SettingsURL = ""

// Watch reports that double taps can't be detected on this platform.
func Watch(mod Modifier, fire func()) error {
	return errors.New("double-tap hotkeys are not supported on this platform; use a key combination")
}

// Active reports whether double taps can be detected.
func Active() bool { return false }
