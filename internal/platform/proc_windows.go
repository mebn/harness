//go:build windows

package platform

import (
	"os/exec"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const createNoWindow = 0x08000000

// hideWindow prevents a console window from flashing for child processes.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// HasChildProcesses reports whether a process has started others that are still running
// (console hosts aside), such as a command running in a shell.
func HasChildProcesses(pid int) bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err := windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if int(e.ParentProcessID) != pid || int(e.ProcessID) == pid {
			continue
		}
		name := windows.UTF16ToString(e.ExeFile[:])
		if !strings.EqualFold(name, "conhost.exe") && !strings.EqualFold(name, "OpenConsole.exe") {
			return true
		}
	}
	return false
}
