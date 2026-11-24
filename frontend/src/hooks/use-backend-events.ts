import { useEffect } from "react";
import { EVENT_SERVER_RECONNECTED, Events } from "@/lib/backend";
import { useApp } from "@/stores/app-store";
import { useUsage } from "@/stores/usage-store";

/** Wires backend events into the app store. Mount once at the root. */
export function useBackendEvents() {
  useEffect(() => {
    const { onMessage, onStatus, onQueue, onSession, onPending, onTasks, onCommands, onReload, init } = useApp.getState();
    const offs = [
      Events.On("chat:message", (e) => onMessage(e.data)),
      Events.On("chat:status", (e) => onStatus(e.data.sessionId, e.data.running)),
      Events.On("chat:queue", (e) => onQueue(e.data)),
      Events.On("session:updated", (e) => onSession(e.data)),
      Events.On("chat:pending", (e) => onPending(e.data)),
      Events.On("chat:tasks", (e) => onTasks(e.data)),
      Events.On("chat:commands", (e) => onCommands(e.data.sessionId, e.data.commands ?? [])),
      Events.On("chat:reload", (e) => void onReload(e.data.sessionId)),
      Events.On("usage:updated", (e) => useUsage.getState().set(e.data)),
      // Events were missed while disconnected (or the server restarted): reload everything.
      Events.On(EVENT_SERVER_RECONNECTED, () => init().catch((e) => console.error("reload after reconnect:", e))),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
