// Platform layer entry point.
//
// The rest of the daemon imports ONLY this file and calls the platform interface — it never
// checks process.platform itself. Swap the implementation here, in one place, by OS:
//   - posix.js   → macOS + Linux (dtach terminals, pkill, systemd, unix env)
//   - windows.js → Windows       (node-pty-direct terminals, pty.kill, schtasks, windows env)
//
// Interface (both modules export the same shape):
//   name                     string
//   terminalSurvivesRestart  boolean  — may a terminal session reattach after a daemon restart?
//   buildChildEnv()          → env    — sanitized environment a spawned agent/shell inherits
//   spawnTerminal({ socket, agent, fresh, ptyOpts }) → node-pty
//   killTerminal(session)             — tear down a terminal session's agent
//   installService(execArgs, opts, ui) / uninstallService(ui)  — boot service
import * as posix from './posix.js';
import * as windows from './windows.js';

const platform = process.platform === 'win32' ? windows : posix;
export default platform;
