// Renders docs/ into GitHub wiki pages. Run by .github/workflows/wiki.yml on
// every push to main that touches docs/. The wiki is a one-way mirror: it is
// never edited by hand, and the workflow wipes and rewrites all pages on each
// run so deleted docs do not leave stale pages behind.
//
// Wiki page names are flat (no directories), so each file's directory becomes
// a name prefix. That prefix also resolves the user/ vs dev/features/ name
// collisions (hygiene, extraction, etc. exist in both tiers).
// docs/plans/ and docs/in-progress/ are excluded: they are ephemeral design
// snapshots per the plan graduation convention, not shipped documentation.
//
// Usage: bun .github/scripts/sync-wiki.ts <output-dir>

import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const EXCLUDED_DIRS = ["docs/plans", "docs/in-progress"];

// The tier READMEs get human-facing landing names instead of "User README".
const SPECIAL_PAGE_NAMES: Record<string, string> = {
  "docs/user/README.md": "User Guide",
  "docs/dev/README.md": "Developer Guide",
  "docs/dev/features/README.md": "Feature Architecture",
};

interface DocFile {
  // Repo-relative posix path, e.g. docs/dev/features/hygiene.md
  relPath: string;
  pageName: string;
  body: string;
}

function titleCase(stem: string): string {
  return stem
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function pageNameFor(relPath: string): string {
  const special = SPECIAL_PAGE_NAMES[relPath];
  if (special) return special;
  const dir = path.posix.dirname(relPath); // docs, docs/user, docs/dev, docs/dev/features
  const stem = path.posix.basename(relPath).replace(/\.md$/, "");
  const topic = titleCase(stem);
  if (dir === "docs/user") return `User ${topic}`;
  if (dir === "docs/dev") return `Dev ${topic}`;
  return `Dev Features ${topic}`;
}

function isExcluded(relPath: string): boolean {
  return EXCLUDED_DIRS.some((dir) => relPath.startsWith(dir + "/"));
}

// Repo-relative paths ("docs/user/README.md") are the identity key everywhere:
// page-name specials, exclusions, and link resolution all match on them.
function collectDocs(repoRoot: string): DocFile[] {
  const files: DocFile[] = [];

  function walk(absDir: string): void {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = path.join(absDir, entry.name);
      const relPath = path.posix.join(
        path.posix.relative(repoRoot, absDir).replaceAll(path.sep, "/"),
        entry.name,
      );
      if (entry.isDirectory()) {
        if (!isExcluded(relPath)) walk(absPath);
        continue;
      }
      if (!entry.name.endsWith(".md") || isExcluded(relPath)) continue;
      files.push({
        relPath,
        pageName: pageNameFor(relPath),
        body: readFileSync(absPath, "utf8"),
      });
    }
  }

  walk(path.join(repoRoot, "docs"));
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// Rewrite relative markdown links between doc files into wiki [[Page]] links.
// Links with no page match (external URLs, in-page anchors, links into the
// excluded plan dirs) are left untouched.
function rewriteLinks(doc: DocFile, pagesByPath: Map<string, string>): string {
  return doc.body.replace(
    /\[([^\]]*)\]\(([^)\s]+)\)/g,
    (full, text: string, target: string) => {
      if (/^(https?:|mailto:|#)/.test(target)) return full;
      if (!target.endsWith(".md") && !/\.md#/.test(target)) return full;
      const [filePart, anchor] = target.split("#");
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(doc.relPath), filePart),
      );
      const pageName = pagesByPath.get(resolved);
      if (!pageName) return full;
      const wikiTarget = anchor ? `${pageName}#${anchor}` : pageName;
      return text === pageName ? `[[${wikiTarget}]]` : `[[${wikiTarget}|${text}]]`;
    },
  );
}

function groupFor(doc: DocFile): string {
  if (doc.relPath.startsWith("docs/dev/features/")) return "Features";
  if (doc.relPath.startsWith("docs/dev/")) return "Developer";
  return "User";
}

const GROUP_ORDER = ["User", "Developer", "Features"] as const;

function renderIndex(grouped: Map<string, DocFile[]>): string {
  const lines = [
    "# thatch",
    "",
    "Persistent memory and cross-session chat for coding agents.",
    "This wiki mirrors the `docs/` directory of [sysread/thatch](https://github.com/sysread/thatch).",
    "",
  ];
  for (const group of GROUP_ORDER) {
    const docs = grouped.get(group);
    if (!docs) continue;
    lines.push(`## ${group}`, "");
    for (const doc of docs) lines.push(`- [[${doc.pageName}]]`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function renderSidebar(grouped: Map<string, DocFile[]>): string {
  const lines = ["**[Home](Home)**", ""];
  for (const group of GROUP_ORDER) {
    const docs = grouped.get(group);
    if (!docs) continue;
    lines.push(`**${group}**`, "");
    for (const doc of docs) lines.push(`- [[${doc.pageName}]]`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

const [outDir] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: bun .github/scripts/sync-wiki.ts <output-dir>");
  process.exit(1);
}

const rootDir = path.resolve(import.meta.dir, "../..");
const docs = collectDocs(rootDir);
const pagesByPath = new Map(docs.map((d) => [d.relPath, d.pageName]));
const grouped = new Map<string, DocFile[]>();
for (const doc of docs) {
  const group = groupFor(doc);
  const bucket = grouped.get(group) ?? [];
  bucket.push(doc);
  grouped.set(group, bucket);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const doc of docs) {
  writeFileSync(path.join(outDir, `${doc.pageName}.md`), rewriteLinks(doc, pagesByPath));
}
writeFileSync(path.join(outDir, "Home.md"), renderIndex(grouped));
writeFileSync(path.join(outDir, "_Sidebar.md"), renderSidebar(grouped));

console.log(`Rendered ${docs.length} doc pages + Home + sidebar to ${outDir}`);
