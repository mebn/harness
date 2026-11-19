import { useState } from "react";
import { FileText } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
          <button key={i} onClick={() => setOpen(p)} className="overflow-hidden rounded-xl border" title={p.fileName}>
            <img src={p.url} alt={p.fileName} loading="lazy" className="max-h-48 max-w-64 object-cover" />
          </button>
        ) : (
          <div key={i} title={p.filePath} className="flex h-10 max-w-64 items-center gap-2 rounded-lg border bg-muted/50 px-3 text-xs">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{p.fileName}</span>
          </div>
        ),
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="w-auto max-w-[90vw] p-2 sm:max-w-[90vw]">
          <DialogTitle className="sr-only">{open?.fileName}</DialogTitle>
          <DialogDescription className="sr-only">Image preview</DialogDescription>
          {open && <img src={open.url} alt={open.fileName} className="max-h-[85vh] max-w-full rounded-md object-contain" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
