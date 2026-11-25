import { useState } from "react";
import { FileText } from "lucide-react";
import { ImagePreview } from "@/components/common/image-preview";
import type { Part } from "@/lib/backend";

const isImage = (p: Part) => !!p.mimeType?.startsWith("image/");

/** Attachments on a sent message: image previews (click to enlarge) and file chips. */
export function AttachmentView({ parts }: { parts: Part[] }) {
  const [open, setOpen] = useState<Part | null>(null);
  if (parts.length === 0) return null;

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {parts.map((p, i) =>
        isImage(p) ? (
          <button key={i} onClick={() => setOpen(p)} className="cursor-zoom-in overflow-hidden rounded-xl border" title={p.fileName}>
            <img src={p.url} alt={p.fileName} loading="lazy" className="max-h-48 max-w-64 object-cover" />
          </button>
        ) : (
          <div key={i} title={p.filePath} className="flex h-10 max-w-64 items-center gap-2 rounded-lg border bg-muted/50 px-3 text-xs">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{p.fileName}</span>
          </div>
        ),
      )}

      <ImagePreview src={open?.url ?? null} alt={open?.fileName} open={!!open} onOpenChange={(o) => !o && setOpen(null)} />
    </div>
  );
}
