package main

import (
	"strconv"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"golang.org/x/sys/windows"
)

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	procGetCursorPos             = user32.NewProc("GetCursorPos")
	procMonitorFromPoint         = user32.NewProc("MonitorFromPoint")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procAttachThreadInput        = user32.NewProc("AttachThreadInput")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procBringWindowToTop         = user32.NewProc("BringWindowToTop")
	procSetFocus                 = user32.NewProc("SetFocus")
	kernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procGetCurrentThreadID       = kernel32.NewProc("GetCurrentThreadId")
)

const monitorDefaultToNearest = 2

// placeWindow centers the window on the screen under the cursor. Unless recenter is set, a
// window already on that screen stays where it is.
func placeWindow(app *application.App, window *application.WebviewWindow, width, height int, recenter bool) {
	screen := app.Screen.GetByID(cursorScreenID())
	if current, _ := window.GetScreen(); !recenter && screen != nil && current != nil && current.ID == screen.ID {
		return
	}
	if screen == nil {
		screen, _ = window.GetScreen()
	}
	window.SetSize(width, height)
	if screen == nil {
		window.Center()
		return
	}
	area := screen.WorkArea
	window.SetScreen(screen)
	window.SetRelativePosition((area.Width-width)/2, (area.Height-height)/2)
}

// cursorScreenID returns the Wails screen ID (the HMONITOR) of the display under the cursor.
func cursorScreenID() string {
	var pt struct{ X, Y int32 }
	if r, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt))); r == 0 {
		return ""
	}
	// MonitorFromPoint takes the POINT by value, packed into one argument.
	packed := uintptr(uint32(pt.X)) | uintptr(uint32(pt.Y))<<32
	hMonitor, _, _ := procMonitorFromPoint.Call(packed, monitorDefaultToNearest)
	if hMonitor == 0 {
		return ""
	}
	return strconv.Itoa(int(hMonitor))
}

// bringToFront makes the window the foreground window. The hotkey is pressed while another
// app is in front and is detected by the server, so Windows' foreground lock would otherwise
// leave the window behind the keyboard focus. Sharing input state with the foreground
// window's thread for a moment lifts it.
func bringToFront(window *application.WebviewWindow) {
	hwnd := uintptr(window.NativeWindow())
	if hwnd == 0 {
		return
	}
	application.InvokeSync(func() {
		fg, _, _ := procGetForegroundWindow.Call()
		if fg == hwnd {
			return
		}
		self, _, _ := procGetCurrentThreadID.Call()
		other, _, _ := procGetWindowThreadProcessID.Call(fg, 0)
		attached := false
		if fg != 0 && other != 0 && other != self {
			r, _, _ := procAttachThreadInput.Call(self, other, 1)
			attached = r != 0
		}
		procBringWindowToTop.Call(hwnd)
		procSetForegroundWindow.Call(hwnd)
		procSetFocus.Call(hwnd)
		if attached {
			procAttachThreadInput.Call(self, other, 0)
		}
	})
	window.Focus() // and the web view inside it
}

// deactivateApp is macOS only: hiding a window on Windows already activates the one below.
func deactivateApp() {}

// snapToCenter centers the window on its screen once it comes to rest within threshold
// pixels of it after being dragged.
func snapToCenter(window *application.WebviewWindow, threshold int) {
	var mu sync.Mutex
	var timer *time.Timer
	window.OnWindowEvent(events.Common.WindowDidMove, func(*application.WindowEvent) {
		mu.Lock()
		defer mu.Unlock()
		if timer != nil {
			timer.Stop()
		}
		timer = time.AfterFunc(250*time.Millisecond, func() { snapRelative(window, threshold) })
	})
}

func snapRelative(window *application.WebviewWindow, threshold int) {
	screen, err := window.GetScreen()
	if err != nil || screen == nil {
		return
	}
	width, height := window.Size()
	x, y := window.RelativePosition()
	cx, cy := (screen.WorkArea.Width-width)/2, (screen.WorkArea.Height-height)/2
	if (x != cx || y != cy) && abs(x-cx) <= threshold && abs(y-cy) <= threshold {
		window.SetRelativePosition(cx, cy)
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
