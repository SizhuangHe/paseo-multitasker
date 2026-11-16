// What a result card's file looks like, for a device that cannot open the path: the first lines of a
// text file or the image itself. Only the card's stored href is read, and only inside the home directory, so the guards below decide what may leave the machine.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, relative, sep } from "node:path";
import type { ResultPreview } from "../shared/rpc";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 80;
const MAX_LINE_CHARS = 400;
const SECRET_NAME =
  /\.env|secret|credential|token|passw|\.(?:pem|key|p12|pfx|kdbx)$|id_rsa|id_ed25519|api[-_]?key|[-_.]key\.json$|service[-_]?account|(?:^|[-_.])cred(?:[-_.]|$)/i;
const TEXT = new Set(["md", "txt", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "toml", "py", "ts", "js", "tex", "bib"]);
const IMAGE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const NONE: ResultPreview = { kind: "none" };

/** The file a preview may read: absolute, a regular file inside home, small, not hidden, with no secret-named file or directory under home, a known type. */
function allowedFile(href: string, home: string): { path: string; ext: string } | null {
  if (!isAbsolute(href)) return null;
  try {
    const path = realpathSync(href);
    const root = realpathSync(home);
    if (!path.startsWith(root + sep)) return null;
    const parts = [...href.split(sep), ...path.split(sep)].filter(Boolean);
    if (parts.some((part) => part.startsWith("."))) return null;
    const below = [relative(root, path), href.startsWith(home + sep) ? relative(home, href) : ""].flatMap((p) => p.split(sep));
    if (below.some((part) => SECRET_NAME.test(part))) return null;
    const ext = extname(path).slice(1).toLowerCase();
    if (!TEXT.has(ext) && !(ext in IMAGE)) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return { path, ext };
  } catch {
    return null;
  }
}

/** A Markdown note's YAML front matter (`---` … `---` at the top) is metadata, not what the note says. */
function withoutFrontMatter(lines: string[], ext: string): string[] {
  if (ext !== "md" || lines[0] !== "---") return lines;
  const end = lines.indexOf("---", 1);
  if (end < 0) return lines;
  const rest = lines.slice(end + 1);
  while (rest.length && !rest[0].trim()) rest.shift();
  return rest;
}

export function readPreview(href: string | undefined, home: string = homedir()): ResultPreview {
  if (!href) return NONE;
  const file = allowedFile(href, home);
  if (!file) return NONE;
  try {
    const bytes = readFileSync(file.path);
    if (file.ext in IMAGE) return { kind: "image", mime: IMAGE[file.ext], data: bytes.toString("base64") };
    const lines = withoutFrontMatter(bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"), file.ext);
    const shown = Math.min(lines.length, MAX_LINES);
    const text = lines
      .slice(0, shown)
      .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line))
      .join("\n");
    return { kind: "text", text, shown, total: lines.length };
  } catch {
    return NONE;
  }
}
