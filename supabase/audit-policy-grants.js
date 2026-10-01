#!/usr/bin/env node
/**
 * audit-policy-grants.js — static check for a Supabase footgun that bites in
 * production but never in the SQL editor:
 *
 *   When an RLS POLICY expression calls public.some_helper(...), Postgres
 *   checks EXECUTE for *the role running the query* (authenticated), NOT for
 *   the table owner and NOT for whichever SECURITY DEFINER function happens to
 *   be the caller. A SECURITY DEFINER wrapper does not help either — the check
 *   is at the policy's own call site.
 *
 * Same class, second shape: a function body that is NOT SECURITY DEFINER runs
 * with the caller's privileges, so it can only call functions the client role
 * can execute. (SECURITY DEFINER bodies are exempt: they run as their owner.)
 *
 * So: every function reachable from a policy — or from a non-definer body —
 * must end up GRANTed to 'authenticated' by the last REVOKE/GRANT that
 * mentions it.
 *
 * Usage: node supabase/audit-policy-grants.js [migrationsDir]
 */

const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.join(__dirname, 'migrations');
const ROLE = 'authenticated';

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => {
    const n = (s) => parseInt(s.match(/^(\d+)/)?.[1] ?? '0', 10);
    return n(a) - n(b) || a.localeCompare(b);
  });

/**
 * Blank out -- and block comments so commented-out SQL is never parsed, while
 * preserving every offset: comments become spaces, newlines stay. That keeps a
 * reported line number equal to the line in the real file (a stripper that
 * deletes text silently shifts every line it follows).
 */
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, (c) => ' '.repeat(c.length));
}

/** Net EXECUTE privilege for ROLE, in statement order across the migration files. */
const canExecute = new Map(); // fn name -> boolean ||undefined||
const privilegeLog = [];

const policies = []; // { file, line, name, table, body }
const bodies = []; // { file, line, name, securityDefiner, body }

for (const file of files) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  const sql = stripComments(raw);

  // ── privilege statements (in order) ──
  const privRe =
    /\b(REVOKE|GRANT)\s+EXECUTE\s+ON\s+FUNCTION\s+([\w."]+)\s*\([^)]*\)\s+(?:FROM|TO)\s+([^;]+);/g;
  for (const m of sql.matchAll(privRe)) {
    const [, kind, fnRaw, rolesRaw] = m;
    const fn = fnRaw.replace(/"/g, '').split('.').pop();
    const roles = rolesRaw
      .split(',')
      .map((r) => r.trim().replace(/"/g, '').toLowerCase());
    if (roles.includes('public') || roles.includes(ROLE)) {
      const value = kind === 'GRANT';
      canExecute.set(fn, kind === 'GRANT');
      privilegeLog.push({ file, kind, fn, roles: roles.join(','), value });
    }
  }

  // ── policies ──
  const policyRe = /CREATE\s+POLICY\s+"?([^"\n]+?)"?\s+ON\s+([\w."]+)([\s\S]*?);/g;
  for (const m of sql.matchAll(policyRe)) {
    const [, name, table, body] = m;
    policies.push({
      file,
      line: raw.slice(0, m.index).split('\n').length,
      name,
      table: table.replace(/"/g, ''),
      body,
    });
  }

  // ── function bodies ──
  const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(([^)]*)\)([\s\S]*?)\$\$/g;
  for (const m of sql.matchAll(fnRe)) {
    const [, nameRaw, , between] = m;
    const bodyStart = m.index + m[0].length;
    const bodyEnd = sql.indexOf('$$', bodyStart);
    const linesBefore = raw.slice(0, m.index).split('\n').length;
    bodies.push({
      file,
      line: linesBefore,
      name: nameRaw.replace(/"/g, ''),
      securityDefiner: /SECURITY\s+DEFINER/i.test(between),
      body: sql.slice(bodyStart, bodyEnd < 0 ? sql.length : bodyEnd),
    });
  }
}

/** public.foo( ... ) calls inside a fragment. */
function calledFunctions(fragment) {
  const names = new Set();
  for (const m of fragment.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
    names.add(m[1]);
  }
  return [...names];
}

const problems = [];
const checked = [];

for (const p of policies) {
  for (const fn of calledFunctions(p.body)) {
    const ok = canExecute.get(fn) === true;
    checked.push({ kind: 'policy', ...p, fn, ok });
    if (!ok) problems.push({ kind: 'policy', ...p, fn, why: 'policy expression' });
  }
}

for (const b of bodies) {
  if (b.securityDefiner) continue; // runs as its owner — exempt
  for (const fn of calledFunctions(b.body)) {
    const ok = canExecute.get(fn) === true;
    checked.push({ kind: 'function', ...b, fn, ok });
    if (!ok) problems.push({ kind: 'function', ...b, fn, why: 'non-definer body' });
  }
}

console.log(`Scanned ${files.length} migrations: ${policies.length} policies, ${bodies.length} function bodies.`);
console.log(`Role assumed for client queries: ${ROLE}\n`);

if (problems.length === 0) {
  console.log('OK — every function called from a policy or a non-definer body is EXECUTE-able by authenticated.');
} else {
  console.log(`FOUND ${problems.length} call(s) the client role cannot execute:\n`);
  for (const p of problems) {
    console.log(`  ✗ ${p.file}:${p.line}`);
    console.log(`      ${p.kind === 'policy' ? `policy "${p.name}" on ${p.table}` : `function ${p.name}`}`);
    console.log(`      calls public.${p.fn}() — ${p.why} runs as the caller; EXECUTE is missing/revoked for ${ROLE}`);
  }
  console.log(
    '\nFix: GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO authenticated;',
  );
}

const granted = [...canExecute.entries()].filter(([, v]) => v).map(([k]) => k);
console.log(`\nFunctions reachable by ${ROLE}: ${granted.length ? granted.join(', ') : '(none)'}`);
process.exitCode = problems.length === 0 ? 0 : 1;
