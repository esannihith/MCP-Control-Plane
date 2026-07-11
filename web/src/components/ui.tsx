import type { ReactNode } from "react";

export const cx = (...parts: (string | false | undefined)[]): string => parts.filter(Boolean).join(" ");

export function PageHeader({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold text-stone-900">{title}</h1>
        {desc && <p className="mt-1 max-w-2xl text-sm text-stone-500">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-stone-200 bg-white", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-stone-100 px-5 py-3">
          {title && <h2 className="text-sm font-semibold text-stone-800">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type ButtonVariant = "primary" | "ghost" | "danger";

export function Button({
  variant = "ghost",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles: Record<ButtonVariant, string> = {
    primary: "bg-emerald-700 text-white border-emerald-700 hover:bg-emerald-800",
    ghost: "bg-white text-stone-700 border-stone-300 hover:bg-stone-50",
    danger: "bg-white text-red-700 border-red-300 hover:bg-red-50",
  };
  return (
    <button
      {...props}
      className={cx(
        "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        className,
      )}
    />
  );
}

type BadgeTone = "green" | "red" | "amber" | "stone" | "blue";

export function Badge({ tone = "stone", children }: { tone?: BadgeTone; children: ReactNode }) {
  const tones: Record<BadgeTone, string> = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-red-50 text-red-700 border-red-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    stone: "bg-stone-100 text-stone-600 border-stone-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
  };
  return (
    <span className={cx("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", tones[tone])}>
      {children}
    </span>
  );
}

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-left text-xs font-semibold uppercase tracking-wide text-stone-400">
            {headers.map((header) => (
              <th key={header} className="px-3 py-2">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100 text-stone-700">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3 py-2.5 align-top", className)}>{children}</td>;
}

export function EmptyState({ title, desc, action }: { title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-stone-300 bg-stone-50/50 px-6 py-14 text-center">
      <div className="max-w-sm">
        <h3 className="text-sm font-semibold text-stone-700">{title}</h3>
        <p className="mt-1 text-sm text-stone-500">{desc}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

/** Marks a control whose real behavior lands in a later part. */
export function PartTag({ part }: { part: number }) {
  return <Badge tone="blue">wired in Part {part}</Badge>;
}

/** Skeleton-phase control to preview both populated and empty layouts. */
export function PreviewToggle({ empty, onChange }: { empty: boolean; onChange: (empty: boolean) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-stone-300 p-0.5 text-xs">
      {(["data", "empty"] as const).map((mode) => (
        <button
          key={mode}
          onClick={() => onChange(mode === "empty")}
          className={cx(
            "rounded-md px-2.5 py-1 font-medium",
            (mode === "empty") === empty ? "bg-stone-800 text-white" : "text-stone-500 hover:text-stone-800",
          )}
        >
          {mode === "data" ? "Preview data" : "Empty state"}
        </button>
      ))}
    </div>
  );
}
