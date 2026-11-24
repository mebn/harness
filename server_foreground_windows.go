//go:build harness_server

package main

import "golang.org/x/sys/windows"

var procAllowSetForegroundWindow = windows.NewLazySystemDLL("user32.dll").NewProc("AllowSetForegroundWindow")

const asfwAny = ^uintptr(0) // ASFW_ANY

// allowForeground lets the desktop app bring the quick chat to the front. The server got the
// key press, so Windows lets it, not the desktop app, take the foreground; this hands that on.
func allowForeground() { procAllowSetForegroundWindow.Call(asfwAny) }
