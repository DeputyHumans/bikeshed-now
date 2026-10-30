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
 *
 * A busy toast is the third kind: it stays exactly as long as the work it
 * describes, and cannot be dismissed, because dismissing it would not stop the
 * work — only hide that it is still happening.
 */
interface Toast {
  id: number;
  message: string;
  kind: "info" | "error" | "busy";
  action?: { label: string; onSelect: () => void };
}

interface ToastApi {
  show: (message: string, action?: Toast["action"]) => void;
  error: (message: string, action?: Toast["action"]) => void;
  /**
   * Say what is happening for as long as `work` is pending, and hand `work`
   * back unchanged, so the caller's own `.then` and `.catch` still apply.
   *
   * For actions whose trigger is gone by the time they run — a menu item — and
   * so have no button left to show that they are busy.
   */
  during: <T>(message: string, work: Promise<T>) => Promise<T>;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId++;
      setToasts((list) => [...list, { ...toast, id }]);
      // One with an action, Undo above all, stays long enough to be reached
      // from the keyboard or a screen reader, not just glimpsed.
      if (toast.kind === "info") setTimeout(() => remove(id), toast.action ? 10_000 : 4000);
      return id;
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show: (message, action) => void push({ message, kind: "info", action }),
      error: (message, action) => void push({ message, kind: "error", action }),
      during: (message, work) => {
        const id = push({ message, kind: "busy" });
        // Both arms, so this branch never reports a rejection of its own: the
        // caller still holds `work` and decides what a failure means.
        const done = () => remove(id);
        work.then(done, done);
        return work;
      },
    }),
    [push, remove],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast${toast.kind === "info" ? "" : ` toast-${toast.kind}`}`}
            role={toast.kind === "error" ? "alert" : "status"}
            aria-live={toast.kind === "error" ? "assertive" : "polite"}
          >
            {toast.kind === "busy" ? <span className="spinner" aria-hidden="true" /> : null}
            <span>{toast.message}</span>
            {toast.kind === "busy" ? null : toast.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  toast.action?.onSelect();
                  remove(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            ) : (
              <button
                type="button"
                className="toast-action"
                onClick={() => remove(toast.id)}
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
