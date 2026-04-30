import { useState } from "react";
import { useAuth } from "../context/AuthContext";

export function useRequireAuth() {
  const { user } = useAuth();
  const [gateOpen, setGateOpen] = useState(false);

  function requireAuth(action?: () => void): boolean {
    if (user) {
      action?.();
      return true;
    }
    setGateOpen(true);
    return false;
  }

  return { requireAuth, gateOpen, setGateOpen, isAuthed: !!user };
}
