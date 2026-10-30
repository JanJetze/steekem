import type { BundleNode } from "./transfer-bundle";

const SKIP = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

async function entryToNode(entry: FileSystemEntry): Promise<BundleNode | null> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
    if (SKIP.has(file.name)) return null;
    return { kind: "file", file };
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const children: BundleNode[] = [];
    // readEntries returns at most ~100 entries per call; loop until empty.
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (batch.length === 0) break;
      for (const c of batch) {
        const n = await entryToNode(c);
        if (n) children.push(n);
      }
    }
    if (children.length === 0) return null;
    return { kind: "folder", name: entry.name, children };
  }
  return null;
}

/**
 * Convert a drop event's DataTransfer items to BundleNodes.
 *
 * Captures entries synchronously (DataTransferItemList becomes invalid after
 * the drop handler returns), then walks directories asynchronously. Falls
 * back to bare files for browsers without webkitGetAsEntry support.
 */
export async function nodesFromDrop(e: DragEvent): Promise<BundleNode[]> {
  const entries: FileSystemEntry[] = [];
  const fallbackFiles: File[] = [];
  const items = e.dataTransfer?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.() ?? null;
      if (entry) {
        entries.push(entry);
      } else {
        const f = item.getAsFile();
        if (f) fallbackFiles.push(f);
      }
    }
  }
  const out: BundleNode[] = [];
  for (const entry of entries) {
    const n = await entryToNode(entry);
    if (n) out.push(n);
  }
  for (const f of fallbackFiles) {
    if (!SKIP.has(f.name)) out.push({ kind: "file", file: f });
  }
  return out;
}

export function nodesFromFilePicker(files: FileList | null): BundleNode[] {
  if (!files) return [];
  const out: BundleNode[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (SKIP.has(f.name)) continue;
    out.push({ kind: "file", file: f });
  }
  return out;
}

interface FolderBuilder {
  name: string;
  folders: Map<string, FolderBuilder>;
  files: File[];
}

/**
 * Convert FileList from <input webkitdirectory> into a nested BundleNode tree
 * by parsing each file's `webkitRelativePath` ("folder/sub/foo.txt" form).
 */
export function nodesFromFolderPicker(files: FileList | null): BundleNode[] {
  if (!files) return [];
  const root: FolderBuilder = { name: "", folders: new Map(), files: [] };
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (SKIP.has(file.name)) continue;
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = rel.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const folderParts = parts.slice(0, -1);
    let cur = root;
    for (const fp of folderParts) {
      let next = cur.folders.get(fp);
      if (!next) {
        next = { name: fp, folders: new Map(), files: [] };
        cur.folders.set(fp, next);
      }
      cur = next;
    }
    cur.files.push(file);
  }

  function toNodes(b: FolderBuilder): BundleNode[] {
    const folders: BundleNode[] = [];
    for (const sub of b.folders.values()) {
      const children = toNodes(sub);
      if (children.length > 0) {
        folders.push({ kind: "folder", name: sub.name, children });
      }
    }
    const fileNodes: BundleNode[] = b.files.map((f) => ({ kind: "file", file: f }));
    return [...folders, ...fileNodes];
  }
  return toNodes(root);
}

/** Remove the node at the given index path. Empty parent folders are pruned. */
export function deleteAtPath(roots: BundleNode[], path: number[]): BundleNode[] {
  if (path.length === 0) return roots;
  const head = path[0]!;
  const rest = path.slice(1);
  if (rest.length === 0) {
    return roots.filter((_, i) => i !== head);
  }
  return roots.flatMap((node, i): BundleNode[] => {
    if (i !== head) return [node];
    if (node.kind !== "folder") return [node];
    const newChildren = deleteAtPath(node.children, rest);
    if (newChildren.length === 0) return [];
    return [{ kind: "folder", name: node.name, children: newChildren }];
  });
}
