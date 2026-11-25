# Rules

- `README.md` holds only the title and how to run the app. Don't add architecture, notes or
  anything else there; documentation for working on the code goes in this file.
- Don't add personal tooling (launch scripts, shortcuts) to the repo.

# Working from the installed build (Windows)

Harness is developed from inside an installed production build in
`%LOCALAPPDATA%\Programs\Harness` (`harness.exe` and `harness-server.exe`, started from the
Start menu). Agents work on this checkout from there, so:

- Never quit, kill or restart the running Harness window or server, and never run `wails3 dev`
  against the default data directory: either ends the agent's own session.
- To try a change, build into this checkout's `bin/` and start a separate instance with its own
  data directory (it starts its own server there, so the installed one is untouched):

  ```powershell
  wails3 build
  $env:HARNESS_DB = "$env:TEMP\harness-test\harness.db"; .\bin\harness.exe
  ```

  Stop it afterwards from its tray icon, or with
  `curl -X POST -H "X-Harness-Token: <token>" http://127.0.0.1:<port>/api/shutdown`
  (values from `%TEMP%\harness-test\server.json`).

## Updating the installed build

Running executables can't be overwritten on Windows, but they can be renamed. Build, move the
running files aside and copy the new ones in:

```powershell
wails3 build
$dir = "$env:LOCALAPPDATA\Programs\Harness"
Get-ChildItem $dir -Filter *.old.exe | Remove-Item -ErrorAction SilentlyContinue  # still running: left for next time
foreach ($name in 'harness', 'harness-server') {
  if (Test-Path "$dir\$name.exe") { Move-Item "$dir\$name.exe" "$dir\$name.$([DateTime]::Now.Ticks).old.exe" }
  Copy-Item "bin\$name.exe" $dir
}
```

Nothing restarts by itself, so this is safe to run from inside the installed Harness. The new
window takes over the next time Harness is opened (close the window and open it from the Start
menu). The server switches to the new binary when a window starts and no agent is running and no
terminal is open; until then the old server keeps running, so the user should reopen Harness
once the agents are done. If the old server and new window can't talk to each other (bound
methods changed), quit Harness Server from the tray and open Harness again.
