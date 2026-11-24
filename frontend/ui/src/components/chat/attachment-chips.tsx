import { FileText, X } from "lucide-react";
import type { PendingAttachment } from "@/hooks/use-attachments";

/** Pending attachments in the composer: image thumbnails and file chips. */
export function AttachmentChips({ items, onRemove }: { items: PendingAttachment[]; onRemove: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {items.map((item) => (
        <div key={item.id} className="group relative">
          {item.previewUrl ? (
            <img
              src={item.previewUrl}
              alt={item.file.name}
              title={item.file.name}
              className="size-14 rounded-lg border object-cover"
            />
          ) : (
            <div
              title={item.file.name}
              className="flex h-14 max-w-48 items-center gap-2 rounded-lg border bg-muted/50 px-3 text-xs"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.file.name}</span>
            </div>
          )}
          <button
            aria-label={`Remove ${item.file.name}`}
            onClick={() => onRemove(item.id)}
            className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm group-hover:opacity-100 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
