#!/usr/bin/env node
/**
 * audit-forward-refs.js — static audit of CREATE-TIME forward references.
 *
 * Postgres validates different things at different times:
 *   * CREATE POLICY      → the expression is parsed and every function must resolve NOW
 *   * LANGUAGE sql body  → likewise (check_function_bodies is on by default,
 *                          including the tables the body reads)
 *   * LANGUAGE plpgsql   → only syntax is checked; names resolve at RUNTIME
 *
 * So a policy, or an SQL function body, may only call functions and read tables
 * that already exist earlier in the same file or in an earlier migration. This
 * script flags the ones that don't.
 *
 * It walks every migration in numeric order, carrying definitions forward, so
 * "created by an earlier migration" is derived from the history itself — there
 * is no allow-list of names to keep in sync. (Auditing a single file, as this
 * script originally did for 021 only, is exactly how two ordering bugs reached
 * production.)
 *
 * Usage:
 *   node supabase/audit-forward-refs.js                # all migrations, in order
 *   node supabase/audit-forward-refs.js <file.sql>     # one file only
 */

const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] || path.join(__dirname, 'migrations');

function listFiles(p) {
  const stat = fs.statSync(p);
  if (stat.isFile()) return [p];
  return fs
    .readdirSync(p)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => {
      const n = (s) => {
        const v = parseInt(s, 10);
        return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
      };
      return n(a) - n(b) || a.localeCompare(b);
    })
    .map((f) => path.join(p, f));
}

const rel = (p) => path.relative(process.cwd(), p).replace(/\\/g, '/');

/** language of the function whose header starts on `lines[i]` */
function languageOf(lines, i) {
  for (let j = i; j < Math.min(i + 12, lines.length); j++) {
    const m = lines[j].match(/^LANGUAGE (\w+)/i);
    if (m) return m[1].toLowerCase();
    if (/^AS \$/.test(lines[j])) break;
  }
  return 'unknown';
}

/**
 * Statements that Postgres validates when it runs them.
 * Returns what is checked, a raw count, and how many lines each statement spans.
 */
function findStatements(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const isPolicy = /^CREATE POLICY/.test(lines[i]);
    // Schema prefix is optional: 001 creates its tables and functions without
    // `public.` (the default schema at the time), later files qualify them.
    const fnMatch = lines[i].match(/^CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)/);
    if (!isPolicy && !fnMatch) continue;

    const chunk = [];
    let j = i;
    while (j < lines.length) {
      chunk.push(lines[j]);
      const trimmed = lines[j].trimEnd();
      if (fnMatch) {
        if (trimmed.endsWith('$$;') || trimmed === ';') break;
      } else if (trimmed.endsWith(';')) {
        break;
      }
      j++;
    }

    const name =
      (fnMatch && fnMatch[1]) ||
      (/CREATE POLICY\s+"([^"]+)"/.exec(chunk.join('\n'))?.[1] ?? 'policy');
    const lang = fnMatch ? languageOf(lines, i) : null;
    const sqlBody = lang === 'sql';

    out.push({
      kind: isPolicy ? 'policy' : `function(${lang})`,
      name,
      start: i + 1,
      line: i + 1,
      // For plpgsql the body is runtime, so only the header (through "AS $$")
      // is create-time checked — matching Postgres, and avoiding false hits on
      // names that do not exist yet but are only used at runtime.
      text: fnMatch && !sqlBody
        ? chunk.slice(0, chunk.findIndex((l) => /^AS \$/.test(l)) + 1).join('\n')
        : chunk.join('\n'),
      checked: isPolicy || sqlBody,
    });
    i = j;
  }
  return out;
}

/** Definitions, drops and table creations inside one file. */
function scanDefinitions(lines) {
  const functions = new Map();
  const tables = new Map();
  const droppedFunctions = new Map();

  lines.forEach((line, i) => {
    const fn = line.match(/^CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)/);
    if (fn && !functions.has(fn[1])) {
      functions.set(fn[1], { line: i + 1, lang: languageOf(lines, i) });
    }
    const table = line.match(/^CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)/);
    if (table && !tables.has(table[1])) tables.set(table[1], { line: i + 1 });
    const drop = line.match(/^DROP FUNCTION IF EXISTS (?:public\.)?(\w+)/);
    if (drop && !droppedFunctions.has(drop[1])) {
      droppedFunctions.set(drop[1], { line: i + 1 });
    }
  });

  return { functions, tables, droppedFunctions };
}

const files = listFiles(TARGET);
const priorFunctions = new Map(); // name -> { file, line, lang }
const priorTables = new Map(); // name -> { file, line }

let checked = 0;
let violations = 0;
const assumed = [];

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const { functions, tables, droppedFunctions } = scanDefinitions(lines);
  const statements = findStatements(lines);
  const localIssues = [];

  for (const st of statements) {
    if (!st.checked) continue;
    checked++;
    const refs = [...st.text.matchAll(/public\.(\w+)/g)].map((m) => m[1]);

    for (const ref of new Set(refs)) {
      if (ref === st.name) continue; // the statement's own name in its header

      const localFn = functions.get(ref);
      const localTable = tables.get(ref);

      if (localFn) {
        if (localFn.line > st.start) {
          localIssues.push(
            `${st.kind} "${st.name}" at line ${st.start} calls public.${ref}() defined later, at line ${localFn.line}`,
          );
        }
        continue;
      }
      if (localTable) {
        if (localTable.line > st.start) {
          localIssues.push(
            `${st.kind} "${st.name}" at line ${st.start} reads table public.${ref} created later, at line ${localTable.line}`,
          );
        }
        continue;
      }
      if (priorFunctions.has(ref)) {
        const dropped = droppedFunctions.get(ref);
        if (dropped) {
          localIssues.push(
            `${st.kind} "${st.name}" at line ${st.start} calls public.${ref}(), dropped at line ${dropped.line}`,
          );
        }
        continue;
      }
      if (priorTables.has(ref)) continue;

      // Neither created here nor in an earlier migration: it must come from
      // outside the migrations (auth.*, a dashboard-created object, …). Report
      // it so a typo cannot hide behind "assumed to exist".
      assumed.push(`${ref} (${rel(file)}:${st.start})`);
    }
  }

  for (const issue of localIssues) console.log(`FORWARD REFERENCE  ${rel(file)}  ${issue}`);
  violations += localIssues.length;

  // Carry this file's definitions forward to the next migration.
  for (const [name, def] of functions) {
    priorFunctions.set(name, { file: rel(file), line: def.line, lang: def.lang });
  }
  for (const [name, def] of tables) {
    priorTables.set(name, { file: rel(file), line: def.line });
  }
}

console.log(`\nmigrations scanned: ${files.length}`);
console.log(`create-time statements checked: ${checked}`);
console.log(`forward references: ${violations}`);
if (assumed.length) {
  console.log('\nreferenced but never created by a migration (must exist outside them):');
  for (const a of assumed) console.log('  ' + a);
}
process.exitCode = violations === 0 ? 0 : 1;
