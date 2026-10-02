import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Layouts are not a security boundary in the App Router: every page and
// every server action checks the session itself (spec §13 "an admin-only
// route check for every admin page").
//
// The check reads the syntax tree, not the text: a guard in a comment or a
// string, in a helper, or after other statements does not count. The guard
// must be the first statement of the exported function's own body, called
// on the name imported from '@/server/request'.

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : f === 'page.tsx' ? [p] : [];
  });
}

const REQUEST = '@/server/request';

function parse(src: string, file: string) {
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === kind) ?? false;
}

/** Names imported unrenamed from '@/server/request' (a local look-alike does not count). */
function requestImports(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== REQUEST) continue;
    if (st.importClause?.isTypeOnly) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) if (!el.propertyName && !el.isTypeOnly) names.add(el.name.text);
  }
  return names;
}

/** `await guard()` with no arguments, guard one of `guards` and imported from '@/server/request'. */
function awaitedGuard(e: ts.Expression | undefined, guards: readonly string[], imported: Set<string>): string | undefined {
  if (!e || !ts.isAwaitExpression(e)) return undefined;
  const c = e.expression;
  if (!ts.isCallExpression(c) || !ts.isIdentifier(c.expression) || c.arguments.length > 0) return undefined;
  const name = c.expression.text;
  return guards.includes(name) && imported.has(name) ? name : undefined;
}

/** Why this function body is not guarded, or undefined when its first statement is the guard. */
function bodyProblem(body: ts.Block | undefined, guards: readonly string[], imported: Set<string>): string | undefined {
  const [first, second] = body?.statements ?? [];
  const want = `first statement must be await ${guards.join('|')}()`;
  if (!first) return want;
  if (ts.isExpressionStatement(first)) {
    const g = awaitedGuard(first.expression, guards, imported);
    if (!g) return want;
    // freshAdmin reports "needs re-auth" in its result: ignoring the result is no guard at all.
    return g === 'freshAdmin' ? 'the result of freshAdmin() must be checked' : undefined;
  }
  if (!ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1) return want;
  const d = first.declarationList.declarations[0];
  const g = awaitedGuard(d.initializer, guards, imported);
  if (!g) return want;
  if (g !== 'freshAdmin') return undefined;
  // `const f = await freshAdmin(); if (!f.ok) return f;`
  const ok =
    ts.isIdentifier(d.name) &&
    second !== undefined &&
    ts.isIfStatement(second) &&
    ts.isPrefixUnaryExpression(second.expression) &&
    second.expression.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPropertyAccessExpression(second.expression.operand) &&
    ts.isIdentifier(second.expression.operand.expression) &&
    second.expression.operand.expression.text === d.name.text &&
    second.expression.operand.name.text === 'ok' &&
    ts.isReturnStatement(second.thenStatement);
  return ok ? undefined : 'the result of freshAdmin() must be checked next: if (!f.ok) return f;';
}

/**
 * Problems in a server-action module: it may export only `async function`s
 * (each guarded) and types. Returns the problems and how many functions it exports.
 */
function actionProblems(src: string, guards: readonly string[], file = 'actions.ts'): { problems: string[]; functions: number } {
  const sf = parse(src, file);
  const imported = requestImports(sf);
  const problems: string[] = [];
  let functions = 0;
  for (const st of sf.statements) {
    const where = `${file}:${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1}`;
    const exported = ts.isExportAssignment(st) || ts.isExportDeclaration(st) || hasModifier(st, ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isTypeAliasDeclaration(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.name && hasModifier(st, ts.SyntaxKind.AsyncKeyword) && !hasModifier(st, ts.SyntaxKind.DefaultKeyword)) {
      functions++;
      const p = bodyProblem(st.body, guards, imported);
      if (p) problems.push(`${where} ${st.name.text}: ${p}`);
      continue;
    }
    problems.push(`${where}: only \`export async function\` and \`export type\` are allowed here`);
  }
  return { problems, functions };
}

/** Problems in a page: its default export is an async function whose first statement is the guard. */
function pageProblems(src: string, guards: readonly string[], file = 'page.tsx'): string[] {
  const sf = parse(src, file);
  const imported = requestImports(sf);
  const defaults = sf.statements.filter(
    (st) => ts.isExportAssignment(st) || (hasModifier(st, ts.SyntaxKind.ExportKeyword) && hasModifier(st, ts.SyntaxKind.DefaultKeyword)),
  );
  if (defaults.length !== 1) return [`${file}: needs exactly one default export`];
  const d = defaults[0];
  if (!ts.isFunctionDeclaration(d) || !hasModifier(d, ts.SyntaxKind.AsyncKeyword)) return [`${file}: the default export must be an async function`];
  const p = bodyProblem(d.body, guards, imported);
  return p ? [`${file}: ${p}`] : [];
}

const APP = 'src/app/(app)';
const ACTIONS = 'src/app/actions';
const ADMIN_GUARDS = ['freshAdmin', 'requireAdmin'] as const;
// admin-noc.ts (ruling 2026-10-01 #8/#9): the number lookup is open to staff
// (requireNoc), while the demo controls stay admin-only (requireAdmin).
const STAFF_ACTION_GUARDS = ['freshAdmin', 'requireAdmin', 'requireNoc'] as const;

describe('route guards', () => {
  it('every admin page calls requireAdmin first', () => {
    const admin = pages(join(APP, 'admin'));
    expect(admin.length).toBeGreaterThanOrEqual(2);
    for (const p of admin) expect(pageProblems(readFileSync(p, 'utf8'), ['requireAdmin'], p)).toEqual([]);
  });

  it('every NOC page calls requireNoc or requireAdmin first (NOC design §4)', () => {
    const noc = pages(join(APP, 'noc'));
    expect(noc.length).toBeGreaterThanOrEqual(7);
    for (const p of noc) expect(pageProblems(readFileSync(p, 'utf8'), ['requireNoc', 'requireAdmin'], p)).toEqual([]);
  });

  it('the NOC demo page is admin-only; the lookup page is open to staff (ruling 2026-10-01 #8/#9)', () => {
    expect(pageProblems(readFileSync(join(APP, 'noc/demo/page.tsx'), 'utf8'), ['requireAdmin'], 'noc/demo/page.tsx')).toEqual([]);
    expect(pageProblems(readFileSync(join(APP, 'noc/lookup/page.tsx'), 'utf8'), ['requireNoc'], 'noc/lookup/page.tsx')).toEqual([]);
  });

  it('every signed-in page calls requireUser, requireNoc or requireAdmin first', () => {
    for (const p of pages(APP)) expect(pageProblems(readFileSync(p, 'utf8'), ['requireUser', 'requireNoc', 'requireAdmin'], p)).toEqual([]);
  });

  it('every admin action checks for a (fresh) admin first', () => {
    const files = readdirSync(ACTIONS).filter((f) => /^admin.*\.tsx?$/.test(f));
    expect(files).toContain('admin.ts');
    expect(files).toContain('admin-noc.ts');
    let functions = 0;
    for (const f of files) {
      // admin-noc.ts (ruling 2026-10-01 #8/#9): its number lookup may use
      // requireNoc; every other admin action file stays admin-only.
      const guards = f === 'admin-noc.ts' ? STAFF_ACTION_GUARDS : ADMIN_GUARDS;
      const r = actionProblems(readFileSync(join(ACTIONS, f), 'utf8'), guards, f);
      expect(r.problems).toEqual([]);
      functions += r.functions;
    }
    expect(functions).toBeGreaterThan(0);
  });

  it('pins the exact guard per export in admin-noc.ts (review M1): only lookupNumberAction may use requireNoc', () => {
    const src = readFileSync(join(ACTIONS, 'admin-noc.ts'), 'utf8');
    const sf = parse(src, 'admin-noc.ts');
    const imported = requestImports(sf);
    const want: Record<string, readonly string[]> = {
      lookupNumberAction: ['requireNoc'],
      demoAction: ['requireAdmin'],
    };
    const seen = new Set<string>();
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name || !hasModifier(st, ts.SyntaxKind.AsyncKeyword) || !hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
        continue;
      }
      const name = st.name.text;
      const guards = want[name];
      if (!guards) continue; // an export the test above already covers generally
      seen.add(name);
      expect(bodyProblem(st.body, guards, imported), name).toBeUndefined();
      // And the other guard must NOT satisfy it: demoAction must not accept requireNoc, nor lookupNumberAction requireAdmin.
      const other = guards[0] === 'requireNoc' ? 'requireAdmin' : 'requireNoc';
      expect(bodyProblem(st.body, [other], imported), `${name} must not also accept ${other}`).not.toBeUndefined();
    }
    expect([...seen].sort()).toEqual(Object.keys(want).sort());
  });

  it('every account action checks for a signed-in user first', () => {
    const r = actionProblems(readFileSync(join(ACTIONS, 'account.ts'), 'utf8'), ['requireUser'], 'account.ts');
    expect(r.problems).toEqual([]);
    expect(r.functions).toBeGreaterThan(0);
  });
});

describe('the route-guard check itself', () => {
  const head = "'use server';\nimport { freshAdmin, requireAdmin } from '@/server/request';\n";
  const check = (body: string) => actionProblems(head + body, ADMIN_GUARDS).problems;

  it('accepts a guarded action', () => {
    expect(check('export type R = { ok: true };\nexport async function a() {\n  const f = await freshAdmin();\n  if (!f.ok) return f;\n  return 1;\n}\n')).toEqual([]);
    expect(check('export async function b() {\n  const { user } = await requireAdmin();\n  return user.id;\n}\n')).toEqual([]);
    expect(check('export async function c() {\n  await requireAdmin();\n}\n')).toEqual([]);
  });

  it.each([
    ['a guard only in a comment', 'export async function a() {\n  // await requireAdmin()\n  return 1;\n}\n'],
    ['a guard only in a string', "export async function a() {\n  return 'await requireAdmin()';\n}\n"],
    ['an exported const arrow function', 'export const x = async () => {\n  await requireAdmin();\n};\n'],
    ['a guard in a later helper', 'export async function a() {\n  return helper();\n}\nasync function helper() {\n  await requireAdmin();\n}\n'],
    ['a guard after another statement', 'export async function a(x: number) {\n  console.log(x);\n  await requireAdmin();\n}\n'],
    ['an ignored freshAdmin result', 'export async function a() {\n  await freshAdmin();\n  return 1;\n}\n'],
    ['an unchecked freshAdmin result', 'export async function a() {\n  const f = await freshAdmin();\n  return f;\n}\n'],
    ['a re-export', 'async function a() {\n  return 1;\n}\nexport { a };\n'],
    ['a default export', 'export default async function a() {\n  await requireAdmin();\n}\n'],
  ])('rejects %s', (_what, body) => {
    expect(check(body)).not.toEqual([]);
  });

  it('rejects a guard that is not the one from @/server/request', () => {
    const src = "'use server';\nasync function requireAdmin() {}\nexport async function a() {\n  await requireAdmin();\n}\n";
    expect(actionProblems(src, ADMIN_GUARDS).problems).not.toEqual([]);
    const renamed = "'use server';\nimport { requireUser as requireAdmin } from '@/server/request';\nexport async function a() {\n  await requireAdmin();\n}\n";
    expect(actionProblems(renamed, ADMIN_GUARDS).problems).not.toEqual([]);
  });

  it('rejects a page whose guard is not its first statement', () => {
    const imp = "import { requireAdmin } from '@/server/request';\n";
    expect(pageProblems(`${imp}export default async function P() {\n  await requireAdmin();\n  return null;\n}\n`, ['requireAdmin'])).toEqual([]);
    expect(pageProblems(`${imp}export default async function P() {\n  // await requireAdmin()\n  return null;\n}\n`, ['requireAdmin'])).not.toEqual([]);
    expect(pageProblems(`${imp}export default async function P() {\n  const x = 1;\n  await requireAdmin();\n  return x;\n}\n`, ['requireAdmin'])).not.toEqual([]);
    expect(pageProblems(`${imp}const P = async () => {\n  await requireAdmin();\n};\nexport default P;\n`, ['requireAdmin'])).not.toEqual([]);
  });
});
