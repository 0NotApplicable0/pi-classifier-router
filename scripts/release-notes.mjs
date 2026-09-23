#!/usr/bin/env node
/**
 * Print Markdown release notes for a tag, built from the commits since the
 * previous `v*` tag. Used by the `release` stage in .gitlab-ci.yml.
 *
 *   node scripts/release-notes.mjs v1.3.0 > release-notes.md
 *
 * Each commit becomes a section: its subject as a heading and its body as the
 * text, with trailers (Co-Authored-By, Signed-off-by) dropped. Commit bodies in
 * this repo are written as prose for exactly this reason. Needs the full
 * history and the tags, so CI must clone with GIT_DEPTH 0 and fetch tags.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: release-notes.mjs <tag>");
  process.exit(2);
}

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let previous = "";
try {
  previous = git("describe", "--tags", "--abbrev=0", "--match", "v*", `${tag}^`);
} catch {
  // First tag: every commit up to it is in the release.
}

const FIELD = "\x1f";
const RECORD = "\x1e";
const log = git("log", "--no-merges", `--format=%s${FIELD}%b${RECORD}`, previous ? `${previous}..${tag}` : tag);
const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by):/i;

const sections = log
  .split(RECORD)
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "")
  .map((entry) => {
    const [subject, body = ""] = entry.split(FIELD);
    const text = body
      .split("\n")
      .filter((line) => !TRAILER.test(line.trim()))
      .join("\n")
      .trim();
    return text === "" ? `### ${subject.trim()}` : `### ${subject.trim()}\n\n${text}`;
  });

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = tag.replace(/^v/, "");
const projectUrl =
  process.env.CI_PROJECT_URL ?? String(pkg.homepage ?? "").replace(/#readme$/, "");

const lines = [
  `npm: [\`${pkg.name}@${version}\`](https://www.npmjs.com/package/${pkg.name}/v/${version})`,
  "",
  previous ? `## Changes since ${previous}` : "## Changes",
  "",
  sections.length > 0 ? sections.join("\n\n") : "_No changes._",
];
if (previous && projectUrl) {
  lines.push("", `**Full diff:** [${previous}...${tag}](${projectUrl}/-/compare/${previous}...${tag})`);
}

process.stdout.write(`${lines.join("\n")}\n`);
