#!/usr/bin/env node
/**
 * Validates .github/workflows/*.yml without GitHub.
 *
 * A workflow file is only exercised when it runs, and a typo inside it (a missing job, an expression
 * that points at a non-existent step output, a `run:` script with a bash syntax error) turns into a red
 * CI run minutes later. This checks, offline:
 *
 *  * the YAML parses, and every job has `runs-on` and at least one step;
 *  * every `needs:` names a job that exists, and there are no cycles;
 *  * every `${{ needs.X.outputs.Y }}` refers to a job that declares output Y, and every
 *    `${{ steps.X.outputs.Y }}` to a step with id X that writes Y to `$GITHUB_OUTPUT`;
 *  * every action `uses:` has a known shape (`owner/repo@ref`), a tag, and not a floating `@main`;
 *  * every `run:` script passes `bash -n`.
 *
 *   node tools/check-workflows.mjs            # all files
 *   node tools/check-workflows.mjs path.yml   # one file
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = join(root, ".github/workflows");

/** Just enough YAML for workflow files: block maps, block sequences, quoted/plain scalars, block text. */
function parseYaml(text, file) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  const indentOf = (l) => l.length - l.trimStart().length;
  const isBlank = (l) => l.trim() === "" || l.trimStart().startsWith("#");

  const stripComment = (s) => {
    // A `#` only starts a comment when it follows whitespace and is not inside quotes.
    let quote = null;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === "#" && (k === 0 || /\s/.test(s[k - 1]))) {
        return s.slice(0, k);
      }
    }
    return s;
  };

  const scalar = (raw) => {
    const s = stripComment(raw).trim();
    if (s === "") return null;
    if (s === "|" || s === ">" || s === "|-" || s === ">-" || s === "|+" || s === ">+" || s === "|2" || s === ">2") {
      return { block: s };
    }
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (s.startsWith("[") && s.endsWith("]")) {
      return s.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== null);
    }
    return s;
  };

  const nextContent = (from) => {
    let k = from;
    while (k < lines.length && isBlank(lines[k])) k++;
    return k;
  };

  function parseBlock(indent) {
    const start = nextContent(i);
    if (start >= lines.length) return null;
    const line = lines[start];
    if (indentOf(line) < indent) return null;
    i = start;
    if (lines[i].trimStart().startsWith("- ")) return parseSeq(indentOf(lines[i]));
    return parseMap(indentOf(lines[i]));
  }

  function parseSeq(indent) {
    const arr = [];
    for (;;) {
      const k = nextContent(i);
      if (k >= lines.length) break;
      const line = lines[k];
      if (indentOf(line) !== indent || !line.trimStart().startsWith("- ")) {
        if (indentOf(line) > indent) throw new Error(`${file}:${k + 1}: bad continuation of a list`);
        break;
      }
      i = k;
      const rest = line.trimStart().slice(2);
      if (rest.trim() === "") {
        i++;
        arr.push(parseBlock(indent + 2));
      } else if (/^[^:]+:(\s|$)/.test(rest) && !rest.trim().startsWith("#")) {
        // "- name: x" starts a map whose first key is on the dash line: re-indent it virtually.
        lines[i] = " ".repeat(indent + 2) + rest;
        arr.push(parseMap(indent + 2));
      } else {
        i++;
        arr.push(scalar(rest));
      }
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    for (;;) {
      const k = nextContent(i);
      if (k >= lines.length) break;
      const line = lines[k];
      if (indentOf(line) !== indent) {
        if (indentOf(line) > indent) throw new Error(`${file}:${k + 1}: unexpected indentation`);
        break;
      }
      const m = /^([^:#][^:]*):(?:\s+(.*))?$/.exec(line.trimEnd());
      if (!m) throw new Error(`${file}:${k + 1}: cannot parse "${line.trim()}"`);
      i = k + 1;
      const key = m[1].trim();
      const inline = m[2];
      if (inline !== undefined && /^[|>][-+]?\d?$/.test(stripComment(inline).trim())) {
        // Block scalar: consume the more-indented lines verbatim.
        const marker = stripComment(inline).trim();
        const out = [];
        let blockIndent = -1;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() === "") {
            out.push("");
            i++;
            continue;
          }
          const ind = indentOf(l);
          if (ind <= indent) break;
          if (blockIndent < 0) blockIndent = ind;
          out.push(l.slice(blockIndent));
          i++;
        }
        while (out.length && out[out.length - 1] === "") out.pop();
        obj[key] = marker.startsWith(">") ? out.join(" ").trim() : out.join("\n") + (marker.endsWith("-") ? "" : "\n");
        continue;
      }
      const value = inline === undefined || stripComment(inline).trim() === "" ? parseBlock(indent + 1) : scalar(inline);
      obj[key] = value;
    }
    return obj;
  }

  const doc = parseBlock(0);
  return doc;
}

const problems = [];
const files = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(dir, f));

let actionCount = 0;
let scriptCount = 0;

for (const path of files) {
  const name = relative(root, path);
  const text = readFileSync(path, "utf8");
  let doc;
  try {
    doc = parseYaml(text, name);
  } catch (err) {
    problems.push(`${name}: ${err.message}`);
    continue;
  }
  if (!doc || typeof doc !== "object") {
    problems.push(`${name}: not a mapping`);
    continue;
  }
  if (!doc.on) problems.push(`${name}: no "on:" trigger`);
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== "object" || !Object.keys(jobs).length) {
    problems.push(`${name}: no jobs`);
    continue;
  }

  const jobNames = Object.keys(jobs);
  const needsOf = (job) => {
    const n = job.needs;
    if (!n) return [];
    return Array.isArray(n) ? n : [n];
  };

  // Cycles and dangling needs.
  for (const id of jobNames) {
    for (const dep of needsOf(jobs[id])) {
      if (!jobNames.includes(dep)) problems.push(`${name}: job "${id}" needs "${dep}", which does not exist`);
    }
  }
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      problems.push(`${name}: needs cycle ${[...stack, id].join(" -> ")}`);
      return;
    }
    state.set(id, "open");
    for (const dep of needsOf(jobs[id])) if (jobs[dep]) visit(dep, [...stack, id]);
    state.set(id, "done");
  };
  for (const id of jobNames) visit(id, []);

  // Step ids and the outputs they write.
  const stepOutputs = new Map(); // jobId -> Map(stepId -> Set(outputNames))
  const stepIds = new Map(); // jobId -> Set(stepId)
  for (const id of jobNames) {
    const job = jobs[id];
    const steps = job.steps;
    if (!Array.isArray(steps) || !steps.length) {
      problems.push(`${name}: job "${id}" has no steps`);
      continue;
    }
    if (!job["runs-on"] && !job.uses) problems.push(`${name}: job "${id}" has no runs-on`);
    const ids = new Set();
    const outs = new Map();
    for (const step of steps) {
      if (typeof step !== "object" || step === null) {
        problems.push(`${name}: job "${id}" has a malformed step`);
        continue;
      }
      if (step.id) {
        if (ids.has(step.id)) problems.push(`${name}: job "${id}" reuses step id "${step.id}"`);
        ids.add(step.id);
        const written = new Set();
        const body = String(step.run ?? "");
        for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=[^\n]*>>\s*"?\$GITHUB_OUTPUT"?/g)) written.add(m[1]);
        for (const m of body.matchAll(/echo\s+"?(?:\{)?([A-Za-z_][A-Za-z0-9_]*)[=}]/g)) written.add(m[1]);
        outs.set(step.id, written);
      }
      if (step.uses) {
        actionCount++;
        const uses = String(step.uses);
        if (!/^[^/\s]+\/[^@\s]+@.+$/.test(uses) && !uses.startsWith("./")) {
          problems.push(`${name}: job "${id}" uses "${uses}", which is not owner/repo@ref`);
        } else if (/@(main|master|HEAD)$/.test(uses)) {
          problems.push(`${name}: job "${id}" uses "${uses}" on a floating branch ref`);
        }
      }
      if (typeof step.run === "string") {
        scriptCount++;
        try {
          execFileSync("bash", ["-n"], { input: step.run, stdio: ["pipe", "ignore", "pipe"] });
        } catch (err) {
          problems.push(`${name}: job "${id}" step "${step.name ?? step.id ?? "run"}" has a bash syntax error: ${String(err.stderr || err.message).trim().split("\n")[0]}`);
        }
      }
      const env = step.env ?? {};
      if (env && typeof env === "object") {
        for (const [k, v] of Object.entries(env)) if (v === null) problems.push(`${name}: job "${id}" step env ${k} is empty`);
      }
    }
    stepIds.set(id, ids);
    stepOutputs.set(id, outs);
  }

  // Expressions: needs.<job>.outputs.<name>, steps.<id>.outputs.<name>.
  for (const [id, job] of Object.entries(jobs)) {
    const declared = (job.outputs && typeof job.outputs === "object") ? Object.keys(job.outputs) : [];
    const body = JSON.stringify(job);
    for (const m of body.matchAll(/needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
      const [, dep, out] = m;
      if (!jobs[dep]) {
        problems.push(`${name}: job "${id}" reads outputs of missing job "${dep}"`);
      } else if (!needsOf(job).includes(dep)) {
        problems.push(`${name}: job "${id}" reads outputs of "${dep}" without needs: ${dep}`);
      } else {
        const depOuts = (jobs[dep].outputs && typeof jobs[dep].outputs === "object") ? Object.keys(jobs[dep].outputs) : [];
        if (!depOuts.includes(out)) problems.push(`${name}: job "${id}" reads needs.${dep}.outputs.${out}, which "${dep}" does not declare`);
      }
    }
    for (const m of body.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
      const [, stepId, out] = m;
      if (!(stepIds.get(id) ?? new Set()).has(stepId)) {
        problems.push(`${name}: job "${id}" reads steps.${stepId}.outputs, but there is no step with that id`);
      } else if (!(stepOutputs.get(id)?.get(stepId) ?? new Set()).has(out)) {
        problems.push(`${name}: job "${id}" reads steps.${stepId}.outputs.${out}, which that step never writes`);
      }
    }
    void declared;
  }
}

if (problems.length) {
  console.log(`FAILED (${problems.length}):`);
  for (const p of problems) console.log("  " + p);
  process.exit(1);
}
console.log(`ok: ${files.length} workflow file(s), ${actionCount} action uses, ${scriptCount} run scripts parsed and bash-checked`);
