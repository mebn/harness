import { useEffect } from "react";
import { EVENT_SERVER_RECONNECTED, Events } from "@/lib/backend";
import { useApp } from "@/stores/app-store";
import { useUsage } from "@/stores/usage-store";

/** Wires backend events into the app store. Mount once at the root. */
export function useBackendEvents() {
  useEffect(() => {
    const { onMessage, onStatus, onSession, init } = useApp.getState();
    const offs = [
      Events.On("chat:message", (e) => onMessage(e.data)),
      Events.On("chat:status", (e) => onStatus(e.data.sessionId, e.data.running)),
      Events.On("session:updated", (e) => onSession(e.data)),
      Events.On("usage:updated", (e) => useUsage.getState().set(e.data)),
      // Events were missed while disconnected (or the server restarted): reload everything.
      Events.On(EVENT_SERVER_RECONNECTED, () => void init()),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
