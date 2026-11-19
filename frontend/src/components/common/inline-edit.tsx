import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Props = {
  value: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  className?: string;
};

/** A borderless input that commits on Enter/blur and cancels on Escape. */
export function InlineEdit({ value, onSubmit, onCancel, className }: Props) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onSubmit(v);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onCancel();
      }}
      className={cn("w-full min-w-0 rounded-sm bg-background px-1 outline-none ring-1 ring-ring", className)}
    />
  );
}
