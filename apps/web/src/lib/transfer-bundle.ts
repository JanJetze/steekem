import { makeZip, predictLength } from "client-zip";

export interface BundleFile {
  kind: "file";
  file: File;
}

export interface BundleFolder {
  kind: "folder";
  name: string;
  children: BundleNode[];
}

export type BundleNode = BundleFile | BundleFolder;

export interface BundleEntry {
  path: string;
  file: File;
}

export interface TransferBundle {
  name: string;
  size: number;
  mimeType: string;
  isBareFile: boolean;
  roots: BundleNode[];
  openStream: () => ReadableStream<Uint8Array>;
}

const SKIP_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function pruneTree(roots: BundleNode[]): BundleNode[] {
  const out: BundleNode[] = [];
  for (const r of roots) {
    if (r.kind === "file") {
      if (SKIP_NAMES.has(r.file.name)) continue;
      out.push(r);
    } else {
      const cleaned = pruneTree(r.children);
      if (cleaned.length > 0) {
        out.push({ kind: "folder", name: r.name, children: cleaned });
      }
    }
  }
  return out;
}

export function flattenEntries(roots: BundleNode[]): BundleEntry[] {
  const out: BundleEntry[] = [];
  function walk(node: BundleNode, prefix: string): void {
    if (node.kind === "file") {
      out.push({ path: prefix + node.file.name, file: node.file });
    } else {
      const next = prefix + node.name + "/";
      for (const c of node.children) walk(c, next);
    }
  }
  for (const r of roots) walk(r, "");
  return out;
}

function sanitizeForFilename(s: string, maxLen = 40): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return "files";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function isoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function bundleName(roots: BundleNode[]): string {
  const date = isoDate();
  if (roots.length === 1 && roots[0].kind === "folder") {
    return `steekem-${sanitizeForFilename(roots[0].name)}-${date}.zip`;
  }
  return `steekem-${roots.length}-items-${date}.zip`;
}

/**
 * Build a transfer bundle from a staged tree.
 *
 * - exactly one File root → bare file (no zip wrapping)
 * - everything else (1 folder, multiple files, mix) → streaming zip
 *
 * Returns null if the tree is empty (after pruning .DS_Store, Thumbs.db,
 * empty folders).
 */
export function buildBundle(roots: BundleNode[]): TransferBundle | null {
  const cleaned = pruneTree(roots);
  if (cleaned.length === 0) return null;

  if (cleaned.length === 1 && cleaned[0].kind === "file") {
    const f = cleaned[0].file;
    return {
      name: f.name,
      size: f.size,
      mimeType: f.type || "application/octet-stream",
      isBareFile: true,
      roots: cleaned,
      openStream: () => f.stream(),
    };
  }

  const entries = flattenEntries(cleaned);
  if (entries.length === 0) return null;

  const meta = entries.map((e) => ({
    name: e.path,
    size: e.file.size,
    lastModified: new Date(e.file.lastModified),
  }));
  const predicted = predictLength(meta);
  // predictLength returns bigint; total zip size always fits in Number range
  // for any realistic browser-driven transfer.
  const zipSize = typeof predicted === "bigint" ? Number(predicted) : predicted;

  return {
    name: bundleName(cleaned),
    size: zipSize,
    mimeType: "application/zip",
    isBareFile: false,
    roots: cleaned,
    openStream: () =>
      makeZip(
        entries.map((e) => ({
          name: e.path,
          input: e.file,
          lastModified: new Date(e.file.lastModified),
        })),
      ),
  };
}

export function totalFileCount(roots: BundleNode[]): number {
  let n = 0;
  for (const r of roots) {
    if (r.kind === "file") n += 1;
    else n += totalFileCount(r.children);
  }
  return n;
}

export function totalSize(roots: BundleNode[]): number {
  let n = 0;
  for (const r of roots) {
    if (r.kind === "file") n += r.file.size;
    else n += totalSize(r.children);
  }
  return n;
}
