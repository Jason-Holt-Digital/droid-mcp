import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isClassDeclaration, isEnumDeclaration, isIdentifier, isMethodDeclaration, isStringLiteral, SyntaxKind } from 'typescript/unstable/ast';
import { API, NodeBuilderFlags } from 'typescript/unstable/sync';

const root = join(import.meta.dirname, '..');
const sdkDir = join(root, 'node_modules/@factory/droid-sdk');
const snapshotFile = join(root, 'catalog/factory-openapi.json');
const catalogFile = join(root, 'src/generated/catalog.json');
const OPENAPI_URL = 'https://docs.factory.com/openapi.json';
const DESTRUCTIVE_WORDS = ['delete', 'remove', 'archive', 'reset', 'cancel', 'kill', 'revoke', 'uninstall', 'purge'];
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const SCHEMA_REF = '#/components/schemas/';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Operation = { id: string; source: 'daemon' | 'rest'; name: string; summary: string; params: Json; destructive: boolean };
type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Json };
type RestOperation = {
  operationId?: string;
  summary?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Json }> };
};
type OpenApi = { info: { version: string }; paths: Record<string, Record<string, RestOperation>>; components?: { schemas?: Record<string, Json> } };

function isDestructive(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/);
  return words.some((w) => DESTRUCTIVE_WORDS.includes(w));
}

function firstParagraph(doc: string): string {
  return doc
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function daemonOperations(): Operation[] {
  const [file] = globSync(join(sdkDir, 'dist/index-*.d.ts'));
  const api = new API({ cwd: root });
  try {
    const project = api.updateSnapshot({ openFiles: [file] }).getDefaultProjectForFile(file);
    const source = project?.program.getSourceFile(file);
    if (!project || !source) throw new Error(`cannot load ${file}`);
    const { checker } = project;
    // DaemonClient method names are the camelCase of the wire method, so match them with case and separators dropped.
    const squash = (name: string) =>
      name
        .replace(/^daemon\./, '')
        .replace(/[._]/g, '')
        .toLowerCase();
    const wire = new Map<string, string>();
    for (const s of source.statements) {
      if (!isEnumDeclaration(s) || !/^Daemon\w*Method$/.test(s.name.text)) continue;
      for (const m of s.members) if (m.initializer && isStringLiteral(m.initializer)) wire.set(squash(m.initializer.text), m.initializer.text);
    }
    const client = source.statements.filter(isClassDeclaration).find((s) => s.name?.text === 'DaemonClient');
    if (!client) throw new Error(`no DaemonClient class in ${file}`);
    const hidden = [SyntaxKind.PrivateKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.StaticKeyword];
    const ops = new Map<string, Operation>();
    for (const m of client.members) {
      if (!isMethodDeclaration(m) || !isIdentifier(m.name) || m.modifiers?.some((x) => hidden.includes(x.kind))) continue;
      const method = wire.get(squash(m.name.text));
      if (!method || ops.has(method)) continue;
      const params = m.parameters.map((p) => {
        const type = checker.getTypeAtLocation(p);
        const text = type ? checker.typeToString(type, undefined, NodeBuilderFlags.NoTruncation | NodeBuilderFlags.InTypeAlias) : 'unknown';
        return `${isIdentifier(p.name) ? p.name.text : 'args'}${p.questionToken ? '?' : ''}: ${text}`;
      });
      const symbol = checker.getSymbolAtLocation(m.name);
      const id = `daemon.${method.replace(/^daemon\./, '')}`;
      ops.set(method, {
        id,
        source: 'daemon',
        name: m.name.text,
        summary: symbol ? firstParagraph(checker.getDocumentationCommentOfSymbol(symbol)) : '',
        params: { description: `(${params.join(', ')})` },
        destructive: isDestructive(`${id} ${m.name.text}`),
      });
    }
    return [...ops.values()];
  } finally {
    api.close();
  }
}

function inlineRefs(value: Json, schemas: Record<string, Json>, seen: string[]): Json {
  if (Array.isArray(value)) return value.map((v) => inlineRefs(v, schemas, seen));
  if (value === null || typeof value !== 'object') return value;
  const ref = value.$ref;
  if (typeof ref === 'string' && ref.startsWith(SCHEMA_REF)) {
    const name = ref.slice(SCHEMA_REF.length);
    if (seen.includes(name)) return { description: `${name} (recursive)` };
    return inlineRefs(schemas[name], schemas, [...seen, name]);
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineRefs(v, schemas, seen)]));
}

function restParams(op: RestOperation, schemas: Record<string, Json>): Json {
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const p of op.parameters ?? []) {
    if (p.in !== 'path' && p.in !== 'query') continue;
    const schema = p.schema && typeof p.schema === 'object' && !Array.isArray(p.schema) ? { ...p.schema } : {};
    if (p.description) schema.description = p.description;
    properties[p.name] = schema;
    if (p.required) required.push(p.name);
  }
  const body = op.requestBody?.content?.['application/json']?.schema;
  if (body) {
    properties.body = body;
    if (op.requestBody?.required) required.push('body');
  }
  return inlineRefs(required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties }, schemas, []);
}

function restOperations(doc: OpenApi): Operation[] {
  const schemas = doc.components?.schemas ?? {};
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const op = item[method];
      if (!op) return [];
      const name = `${method.toUpperCase()} ${path}`;
      const id = `rest.${op.operationId ?? name}`;
      return [
        {
          id,
          source: 'rest' as const,
          name,
          summary: op.summary ?? '',
          params: restParams(op, schemas),
          destructive: method === 'delete' || isDestructive(`${id} ${name}`),
        },
      ];
    }),
  );
}

const args = process.argv.slice(2);
if (args.includes('--refresh')) {
  const res = await fetch(OPENAPI_URL);
  if (!res.ok) throw new Error(`GET ${OPENAPI_URL}: ${res.status}`);
  writeFileSync(snapshotFile, await res.text());
}
const doc: OpenApi = JSON.parse(readFileSync(snapshotFile, 'utf8'));
const sdkVersion: string = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version;
const operations = [...daemonOperations(), ...restOperations(doc)].sort((a, b) => (a.id < b.id ? -1 : 1));
const catalog = `${JSON.stringify({ sdkVersion, openapiVersion: doc.info.version, operations }, null, 2)}\n`;

if (args.includes('--check')) {
  const committed = existsSync(catalogFile) ? readFileSync(catalogFile, 'utf8') : '';
  if (committed !== catalog) {
    const built = /"sdkVersion": "([^"]*)"/.exec(committed)?.[1];
    const why = built === sdkVersion ? 'differs from the sources' : `was built for @factory/droid-sdk ${built ?? '(none)'}, installed is ${sdkVersion}`;
    console.error(`src/generated/catalog.json is stale: it ${why}. Run: npm run codegen`);
    process.exit(1);
  }
} else {
  writeFileSync(catalogFile, catalog);
}
