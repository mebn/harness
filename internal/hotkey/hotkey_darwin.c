//go:build darwin

#include <ApplicationServices/ApplicationServices.h>

#include "hotkey_darwin.h"
#include "_cgo_export.h"

static CFMachPortRef harnessTap = NULL;

// Forwards key presses and modifier changes to Go, which decides what counts as a tap of the
// watched modifier.
static CGEventRef harnessTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
	if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
		CGEventTapEnable(harnessTap, true);
	} else if (type == kCGEventKeyDown) {
		goKeyDown();
	} else if (type == kCGEventFlagsChanged) {
		goFlagsChanged((int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode),
			(unsigned long long)CGEventGetFlags(event));
	}
	return event;
}

bool harnessHasAccess(void) {
	return CGPreflightListenEventAccess();
}

void harnessRequestAccess(void) {
	CGRequestListenEventAccess();
}

// harnessStartTap installs a listen-only event tap on the main run loop. Returns false if the
// tap could not be created, usually because Input Monitoring has not been granted yet.
bool harnessStartTap(void) {
	CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventKeyDown);
	harnessTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
		kCGEventTapOptionListenOnly, mask, harnessTapCallback, NULL);
	if (harnessTap == NULL) {
		return false;
	}
	CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, harnessTap, 0);
	CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
	CFRelease(source);
	CGEventTapEnable(harnessTap, true);
	return true;
}
