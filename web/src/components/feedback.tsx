import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui";

// ---------------- Toasts ----------------

interface Toast {
  id: number;
  message: string;
  tone: "info" | "success" | "error";
}

const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});

export const useToast = () => useContext(ToastContext);

// ---------------- Confirm dialog ----------------

interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel?: string;
  resolve: (confirmed: boolean) => void;
}

const ConfirmContext = createContext<(title: string, body: string, confirmLabel?: string) => Promise<boolean>>(() =>
  Promise.resolve(false),
);

/** `if (await confirm("Remove?", "This cannot be undone")) …` */
export const useConfirm = () => useContext(ConfirmContext);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 3500);
  }, []);

  const confirm = useCallback(
    (title: string, body: string, confirmLabel = "Confirm") =>
      new Promise<boolean>((resolve) => setConfirmRequest({ title, body, confirmLabel, resolve })),
    [],
  );

  const settle = (confirmed: boolean) => {
    confirmRequest?.resolve(confirmed);
    setConfirmRequest(null);
  };

  return (
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={confirm}>
        {children}

        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={
                "pointer-events-auto rounded-lg border px-4 py-2.5 text-sm shadow-sm " +
                (t.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : t.tone === "error"
                    ? "border-red-200 bg-red-50 text-red-800"
                    : "border-stone-200 bg-white text-stone-700")
              }
            >
              {t.message}
            </div>
          ))}
        </div>

        {confirmRequest && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-4" onClick={() => settle(false)}>
            <div
              role="dialog"
              aria-modal="true"
              className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-5 shadow-lg"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="text-sm font-semibold text-stone-900">{confirmRequest.title}</h2>
              <p className="mt-2 text-sm text-stone-500">{confirmRequest.body}</p>
              <div className="mt-5 flex justify-end gap-2">
                <Button onClick={() => settle(false)}>Cancel</Button>
                <Button variant="danger" onClick={() => settle(true)} autoFocus>
                  {confirmRequest.confirmLabel}
                </Button>
              </div>
            </div>
          </div>
        )}
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
