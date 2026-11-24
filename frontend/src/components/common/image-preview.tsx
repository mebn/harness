import { useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";

/**
 * An image shown large over the app. Images stay in the app: opening their URL would go to the
 * system browser, where the app's own addresses (attachments, tool output) don't resolve.
 */
export function ImagePreview({
  src,
  alt = "",
  open,
  onOpenChange,
}: {
  src: string | null;
  alt?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/75 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // Clicking anywhere but the image closes it.
          onClick={(e) => e.target === e.currentTarget && onOpenChange(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-10 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">{alt || "Image"}</DialogPrimitive.Title>
          {src && (
            <img src={src} alt={alt} className="max-h-full max-w-full rounded-md object-contain shadow-2xl select-none" draggable={false} />
          )}
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A thumbnail that opens the image in the preview when clicked. */
export function PreviewableImage({ src, alt = "", children }: { src: string; alt?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={alt || "Open image"} className="cursor-zoom-in">
        {children}
      </button>
      <ImagePreview src={src} alt={alt} open={open} onOpenChange={setOpen} />
    </>
  );
}
