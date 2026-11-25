package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// Centers the window, sized width x height, on the screen under the cursor. Unless recenter
// is set, a window already on that screen stays where it is.
static void harnessPlaceWindow(void *nsWindow, int width, int height, int recenter) {
	dispatch_async(dispatch_get_main_queue(), ^{
		NSWindow *window = (NSWindow *)nsWindow;
		if (window == nil) return;

		NSScreen *screen = [NSScreen mainScreen];
		NSPoint mouse = [NSEvent mouseLocation];
		for (NSScreen *s in [NSScreen screens]) {
			if (NSMouseInRect(mouse, s.frame, NO)) { screen = s; break; }
		}
		if (!recenter && window.screen == screen) return;
		NSRect area = screen.visibleFrame;
		[window setFrame:NSMakeRect(round(NSMidX(area) - width / 2.0), round(NSMidY(area) - height / 2.0), width, height)
		         display:YES];
	});
}

// Hands the keyboard back to the app you were in, if showing the quick chat made Harness
// the active app.
static void harnessDeactivate(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (NSApp.isActive) [NSApp deactivate];
	});
}
*/
import "C"

import "github.com/wailsapp/wails/v3/pkg/application"

func placeWindow(_ *application.App, window *application.WebviewWindow, width, height int, recenter bool) {
	r := 0
	if recenter {
		r = 1
	}
	C.harnessPlaceWindow(window.NativeWindow(), C.int(width), C.int(height), C.int(r))
}

// bringToFront isn't needed on macOS: the non-activating panel takes the keyboard when shown.
func bringToFront(*application.WebviewWindow) {}

func deactivateApp() { C.harnessDeactivate() }

// snapToCenter does nothing on macOS, where AppKit runs the drag.
func snapToCenter(*application.WebviewWindow, int) {}
