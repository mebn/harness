import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentInput } from "@bindings/harness/server/internal/services/models";

/** Must match attach.MaxSize in the backend. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type PendingAttachment = {
  id: string;
  file: File;
  /** Object URL for image thumbnails; revoked when removed. */
  previewUrl?: string;
};

let seq = 0;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Files attached in the composer before sending. */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Free object URLs on unmount.
  useEffect(() => () => itemsRef.current.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl)), []);

  const add = useCallback((files: Iterable<File>) => {
    const next: PendingAttachment[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is larger than 20 MB`);
        continue;
      }
      // Pasted screenshots arrive as "image.png"; give them a unique, readable name.
      const name = file.name && file.name !== "image.png" ? file.name : `pasted-${Date.now()}-${seq}.png`;
      const named = name === file.name ? file : new File([file], name, { type: file.type });
      next.push({
        id: `att-${++seq}`,
        file: named,
        previewUrl: named.type.startsWith("image/") ? URL.createObjectURL(named) : undefined,
      });
    }
    if (next.length) setItems((list) => [...list, ...next]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((list) => {
      const item = list.find((i) => i.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return list.filter((i) => i.id !== id);
    });
  }, []);

  /** Clears the list without revoking URLs (the caller may restore on failure). */
  const take = useCallback(() => {
    const taken = itemsRef.current;
    setItems([]);
    return taken;
  }, []);

  const restore = useCallback((list: PendingAttachment[]) => setItems(list), []);

  return { items, error, setError, add, remove, take, restore };
}

export async function toInputs(items: PendingAttachment[]): Promise<AttachmentInput[]> {
  return Promise.all(
    items.map(async (i) => ({ name: i.file.name, mimeType: i.file.type, data: await readBase64(i.file) })),
  );
}

export function releasePreviews(items: PendingAttachment[]) {
  items.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
}
