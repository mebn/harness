import type { ReactNode } from "react";

/** A titled part of a settings page. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-7 items-center justify-between gap-4">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Rows in a rounded box, divided by lines. */
export function List({ children }: { children: ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-lg border">{children}</div>;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
      <div className="text-sm">{label}</div>
      {children}
    </div>
  );
}
