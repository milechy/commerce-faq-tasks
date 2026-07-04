import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface AdminAgentUIContextValue {
  isOpen: boolean;
  seedQuery: string | null;
  toggle: () => void;
  close: () => void;
  openWithQuery: (query: string) => void;
}

const AdminAgentUIContext = createContext<AdminAgentUIContextValue | null>(null);

/** Shares Admin Agent panel open/seed-query state between App.tsx (which
 * mounts the panel) and AppSwitcher's locked R2C2 tab, which opens the
 * assistant with a seeded question instead of just linking out. */
export function AdminAgentUIProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [seedQuery, setSeedQuery] = useState<string | null>(null);

  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  const close = useCallback(() => setIsOpen(false), []);
  const openWithQuery = useCallback((query: string) => {
    setSeedQuery(query);
    setIsOpen(true);
  }, []);

  return (
    <AdminAgentUIContext.Provider value={{ isOpen, seedQuery, toggle, close, openWithQuery }}>
      {children}
    </AdminAgentUIContext.Provider>
  );
}

export function useAdminAgentUI(): AdminAgentUIContextValue {
  const ctx = useContext(AdminAgentUIContext);
  if (!ctx) throw new Error("useAdminAgentUI must be used inside AdminAgentUIProvider");
  return ctx;
}
