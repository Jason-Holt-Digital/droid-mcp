import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const sdkDir = join(root, 'node_modules/@factory/droid-sdk');
const snapshotFile = join(root, 'catalog/factory-openapi.json');
const catalogFile = join(root, 'src/generated/catalog.json');
const OPENAPI_URL = 'https://docs.factory.com/openapi.json';
// typescript/unstable/* may change in any release, so codegen runs only on the version it was written for.
const TS_VERSION = '7.0.2';
// Destructive: REST DELETE, plus these ids, which destroy, overwrite or invalidate something. Checked by hand.
const REST_DESTRUCTIVE = [
  'revokeServiceAccountApiKey',
  'rotateServiceAccountApiKey',
  'cancelEnvironmentBuild',
  'restartComputer',
  'updateOrganizationComputerSecrets',
];
const DAEMON_DESTRUCTIVE = [
  'archive_session',
  'cancel_mcp_auth',
  'cleanup_worktree',
  'clear_mcp_auth',
  'close_terminal',
  'delete_automation',
  'delete_cron',
  'delete_custom_model',
  'delete_model_provider',
  'delete_model_provider_entry',
  'delete_shared_folder_entry',
  'delete_worktree_setup_profile',
  'execute_rewind',
  'git_push',
  'kill_background_process',
  'kill_worker_session',
  'logout',
  'push_cwd_file_to_url',
  'remove_marketplace',
  'remove_mcp_server',
  'uninstall_plugin',
  'write_shared_folder_file',
  'write_terminal_data',
  'write_workspace_file_content',
];
// Read-only: REST GET, plus these daemon methods, which only read. Methods that return secrets or arbitrary file contents are left out.
const DAEMON_READ_ONLY = [
  'automation_memory_list',
  'automation_memory_read',
  'check_folder_trust',
  'check_session_copy',
  'get_automation_history',
  'get_automation_visual',
  'get_checkout_metadata',
  'get_context_breakdown',
  'get_default_settings',
  'get_folder_starter_signals',
  'get_git_diff',
  'get_git_diff_file_contents',
  'get_message_blocks',
  'get_mission_agent_roster',
  'get_rewind_info',
  'get_semantic_diff_cache',
  'get_session_messages',
  'get_session_turn_outcome',
  'get_user_preferences_state',
  'inspect_mission_readiness',
  'inspect_worktree_deletion',
  'list_automations',
  'list_available_plugins',
  'list_available_sessions',
  'list_commands',
  'list_crons',
  'list_files',
  'list_git_branches',
  'list_installed_plugins',
  'list_managed_worktrees',
  'list_marketplaces',
  'list_mcp_registry',
  'list_mcp_tools',
  'list_models',
  'list_opened_sessions',
  'list_shared_folder',
  'list_skills',
  'list_terminals',
  'list_worktree_setup_profiles',
  'resolve_file_links',
  'resolve_pull_request_statuses',
  'search_files',
  'search_sessions',
  'validate_working_directory',
];
// These return keys or tokens; droid_call refuses them so droid-mcp never hands a secret to the agent.
const SECRET = [
  'daemon.get_proxy_token',
  'daemon.get_mcp_config',
  'daemon.list_custom_models',
  'daemon.list_model_providers',
  'daemon.preview_model_provider',
  'rest.createServiceAccountApiKey',
  'rest.rotateServiceAccountApiKey',
];
// Not a classifier: a new daemon method whose name has one of these words must be put in a list above by hand.
const DESTRUCTIVE_WORDS = [
  'delete',
  'remove',
  'archive',
  'reset',
  'cancel',
  'kill',
  'revoke',
  'uninstall',
  'purge',
  'clear',
  'cleanup',
  'logout',
  'push',
  'write',
  'rewind',
];
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const SCHEMA_REF = '#/components/schemas/';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Operation = {
  id: string;
  source: 'daemon' | 'rest';
  name: string;
  summary: string;
  params: Json;
  readOnly: boolean;
  destructive: boolean;
  secret: boolean;
};
type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Json };
type RestOperation = {
  operationId?: string;
  summary?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Json }> };
};
type OpenApi = { info: { version: string }; paths: Record<string, Record<string, RestOperation>>; components?: { schemas?: Record<string, Json> } };

const fail = (message: string): never => {
  console.error(`codegen: ${message}`);
  process.exit(1);
};

const tsVersion: string = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
if (tsVersion !== TS_VERSION)
  fail(`written for typescript ${TS_VERSION}, installed is ${tsVersion}. Its unstable API may have moved: check scripts/codegen.ts, then update TS_VERSION.`);

// Loaded after the version check, so a moved API fails with the message above, not an import error.
const { isClassDeclaration, isEnumDeclaration, isIdentifier, isMethodDeclaration, isStringLiteral, SyntaxKind } = await import('typescript/unstable/ast');
const { API, NodeBuilderFlags } = await import('typescript/unstable/sync');

const soundsDestructive = (method: string) => method.split('_').some((w) => DESTRUCTIVE_WORDS.includes(w));

function firstParagraph(doc: string): string {
  return doc
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function daemonOperations(): Operation[] {
  try {
    return readDaemonOperations();
  } catch (err) {
    return fail(`reading DaemonClient with typescript/unstable failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readDaemonOperations(): Operation[] {
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
      const bare = method.replace(/^daemon\./, '');
      const id = `daemon.${bare}`;
      const destructive = DAEMON_DESTRUCTIVE.includes(bare);
      if (!destructive && !DAEMON_READ_ONLY.includes(bare) && soundsDestructive(bare)) {
        fail(`${id} sounds destructive but is in neither DAEMON_DESTRUCTIVE nor DAEMON_READ_ONLY. Classify it by hand.`);
      }
      ops.set(method, {
        id,
        source: 'daemon',
        name: m.name.text,
        summary: symbol ? firstParagraph(checker.getDocumentationCommentOfSymbol(symbol)) : '',
        params: { description: `(${params.join(', ')})` },
        readOnly: DAEMON_READ_ONLY.includes(bare),
        destructive,
        secret: SECRET.includes(id),
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
          readOnly: method === 'get',
          destructive: method === 'delete' || REST_DESTRUCTIVE.includes(op.operationId ?? ''),
          secret: SECRET.includes(id),
        },
      ];
    }),
  );
}

const args = process.argv.slice(2);
if (args.includes('--refresh')) {
  const res = await fetch(OPENAPI_URL);
  if (!res.ok) fail(`GET ${OPENAPI_URL}: ${res.status}`);
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
