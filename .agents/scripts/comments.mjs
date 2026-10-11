#!/usr/bin/env node
// `node .agents/scripts/comments.mjs [--all] <base> [<head>]`: every comment block a diff adds or
// edits, each with the code line after it. `--all` lists every comment block in the files the
// diff touches, unchanged ones too, for the weekly comment routine. Without <head>, the diff runs
// from <base> to the working tree, untracked files included. Code files only (JavaScript,
// TypeScript, shell); tool directives are left out. Prints nothing when no comment is listed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SHELL = /\.(?:sh|bash)$/;
const DIRECTIVE =
  /^(?:\/\/\/?|\/\*+|\{\/\*+|\*|#)\s*(?:@ts-|oxlint-|eslint-|fallow-ignore|Stryker (?:disable|restore)|prettier-ignore|biome-ignore|c8 |istanbul |shellcheck |<reference |#?(?:end)?region\b)/;

const args = process.argv.slice(2);
const all = args[0] === "--all";
const [base, head] = all ? args.slice(1) : args;
if (base === undefined) {
  console.error("usage: comments.mjs [--all] <base> [<head>]");
  process.exit(64);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const range = head === undefined ? [base] : [base, head];

const files = git("diff", "--name-only", "--diff-filter=d", ...range).split("\n");
if (head === undefined)
  files.push(...git("ls-files", "--others", "--exclude-standard").split("\n"));

const out = [];
for (const path of [...new Set(files)].filter((f) => SCRIPT.test(f) || SHELL.test(f)).sort()) {
  const text =
    head === undefined
      ? existsSync(path)
        ? readFileSync(path, "utf8")
        : ""
      : git("show", `${head}:${path}`);
  const lines = text.split("\n");
  const added = addedLines(path, lines.length);
  const kinds = SHELL.test(path) ? shellKinds(lines) : scriptKinds(lines);

  const shown = new Set();
  for (let n = 1; n <= lines.length; n++) {
    if (!kinds[n - 1].comment || shown.has(n) || !(all || added.has(n))) continue;
    let [start, end] = [n, n];
    if (!kinds[n - 1].code) {
      while (start > 1 && kinds[start - 2].comment && !kinds[start - 2].code) start--;
      while (end < lines.length && kinds[end].comment && !kinds[end].code) end++;
    }
    for (let i = start; i <= end; i++) shown.add(i);
    const block = lines.slice(start - 1, end);
    if (block.every((l) => DIRECTIVE.test(l.trim()) || l.trim() === "")) continue;

    const changed = block.filter((_, i) => added.has(start + i)).length;
    const state = changed === block.length ? "added" : changed > 0 ? "edited" : "unchanged";
    out.push(`${path}:${start === end ? start : `${start}-${end}`} (${state})`);
    block.forEach((l, i) => out.push(`  ${start + i} | ${l}`));
    if (!kinds[n - 1].code) {
      const next = lines.findIndex((l, i) => i >= end && l.trim() !== "");
      if (next !== -1) out.push(`  ${next + 1} > ${lines[next]}`);
    }
  }
}
if (out.length > 0) console.log(out.join("\n"));

function addedLines(path, count) {
  const tracked = git("ls-files", "--", path).trim() !== "" || head !== undefined;
  if (!tracked) return new Set(Array.from({ length: count }, (_, i) => i + 1));
  const added = new Set();
  for (const line of git("diff", "-U0", "--no-color", ...range, "--", path).split("\n")) {
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const start = Number(hunk[1]);
    const size = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let i = start; i < start + size; i++) added.add(i);
  }
  return added;
}

function shellKinds(lines) {
  return lines.map((line, i) => {
    const t = line.trim();
    const comment = t.startsWith("#") && !(i === 0 && t.startsWith("#!"));
    return { comment, code: !comment };
  });
}

function scriptKinds(lines) {
  let inBlock = false;
  return lines.map((line) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      return { comment: true, code: false };
    }
    if (t.startsWith("//")) return { comment: true, code: false };
    const open = t.startsWith("/*") ? 2 : t.startsWith("{/*") ? 3 : -1;
    if (open !== -1) {
      if (!t.includes("*/", open)) inBlock = true;
      return { comment: true, code: false };
    }
    return { comment: trailingComment(line), code: true };
  });
}

function trailingComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return true;
    }
  }
  return false;
}
