import { useEffect } from "react";
import { Events } from "@/lib/backend";
import { useApp } from "@/stores/app-store";
import { useUsage } from "@/stores/usage-store";

/** Wires backend events into the app store. Mount once at the root. */
export function useBackendEvents() {
  useEffect(() => {
    const { onMessage, onStatus, onSession } = useApp.getState();
    const offs = [
      Events.On("chat:message", (e) => onMessage(e.data)),
      Events.On("chat:status", (e) => onStatus(e.data.sessionId, e.data.running)),
      Events.On("session:updated", (e) => onSession(e.data)),
      Events.On("usage:updated", (e) => useUsage.getState().set(e.data)),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
