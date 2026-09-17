// SPDX-License-Identifier: Apache-2.0
// Transient messages, announced politely.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Errors are announced ASSERTIVELY and never auto-dismiss; successes are polite
 * and fade. Something that went wrong is worth interrupting for and worth
 * leaving on screen until it has been read. Something that went right is not.
 */
interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
  action?: { label: string; onSelect: () => void };
}

interface ToastApi {
  show: (message: string, action?: Toast["action"]) => void;
  error: (message: string, action?: Toast["action"]) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextId++;
    setToasts((list) => [...list, { ...toast, id }]);
    if (toast.kind !== "error") {
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4000);
    }
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show: (message, action) => push({ message, kind: "info", action }),
      error: (message, action) => push({ message, kind: "error", action }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={toast.kind === "error" ? "toast toast-error" : "toast"}
            role={toast.kind === "error" ? "alert" : "status"}
            aria-live={toast.kind === "error" ? "assertive" : "polite"}
          >
            <span>{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  toast.action?.onSelect();
                  setToasts((list) => list.filter((t) => t.id !== toast.id));
                }}
              >
                {toast.action.label}
              </button>
            ) : (
              <button
                type="button"
                className="toast-action"
                onClick={() => setToasts((list) => list.filter((t) => t.id !== toast.id))}
              >
                Dismiss
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
