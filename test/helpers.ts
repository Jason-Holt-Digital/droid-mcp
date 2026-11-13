import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanSessions, type SessionRecord } from '../src/catalog.ts';
import { parseCustomModels, parseHelp, type ModelCatalog } from '../src/models.ts';

export const FIXTURES = fileURLToPath(new URL('./fixtures/sessions', import.meta.url));

export const IDS = {
  liveOrchestrator: '8ddbc264-6932-58f2-a1e8-323e4207e00d',
  liveAgentNewer: '1d7f7142-c851-594a-b695-21038179bfe9',
  liveAgentOlder: 'db9ee7c9-3692-55b6-818a-55dee2d3eb9d',
  archivedOrchestrator: 'a11ff0aa-7866-5530-969f-0ec4491f2224',
  archivedAgentPayment: 'c054d97f-7788-5d18-959e-2cc8ed8a06fa',
  archivedAgentResearch: '0c20addc-ecf3-5dd9-802f-3f04a94e686a',
  missingOrchestrator: '0b691f38-3cb1-510d-ba50-881858f88438',
  orphanAgentA: '9265b020-d83e-5497-86c6-b4669e4879c5',
  orphanAgentB: '97a62cfa-b4ce-547c-8c4a-f155826afb71',
  subagent: 'cf1f5525-259e-574a-b439-3f74668b4e04',
  subagentParent: '900cb9e9-c0e2-5b47-983c-21e67cf0b317',
  missionSubagent: '5ea448f1-be74-5504-86fa-4b05d771c0a0',
  archivedScratch: '10cfe397-bd88-59d2-b89c-c4f79d45bae6',
  liveStandalone: 'aa763cb7-e4cc-5b2b-bced-3ba81a5cfe24',
  archivedService: '07484013-afa4-57cb-82c0-16cbd16d6c2a',
};

const UPDATED: Record<string, number> = {
  [IDS.liveOrchestrator]: 1000,
  [IDS.liveAgentNewer]: 3000,
  [IDS.liveAgentOlder]: 2000,
  [IDS.archivedOrchestrator]: 500,
  [IDS.archivedAgentPayment]: 400,
  [IDS.archivedAgentResearch]: 9000,
  [IDS.orphanAgentA]: 10_000,
  [IDS.orphanAgentB]: 10_001,
  [IDS.subagent]: 200,
  [IDS.subagentParent]: 100,
  [IDS.missionSubagent]: 300,
  [IDS.archivedScratch]: 50,
  [IDS.liveStandalone]: 8000,
  [IDS.archivedService]: 7000,
};

export async function fixtureRecords(): Promise<SessionRecord[]> {
  const records = await scanSessions(FIXTURES);
  return records.map((r) => ({ ...r, updatedAt: UPDATED[r.id] ?? r.updatedAt }));
}

export const HELP = readFileSync(new URL('./fixtures/exec-help.txt', import.meta.url), 'utf8');
export const SECRET = 'sk-test-must-not-leak';
export const SETTINGS = {
  customModels: [
    {
      id: 'custom:my-proxy:opus-5-5',
      displayName: 'My proxy: Opus 5.5',
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      baseUrl: 'http://localhost:8080/v1/anthropic?token=abc',
      apiKey: SECRET,
      apiKeyHelper: `echo ${SECRET}`,
      headers: { Authorization: `Bearer ${SECRET}` },
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      maxContextLimit: 200000,
    },
    { displayName: 'no id' },
  ],
};
export const catalog = (): ModelCatalog => ({ ...parseHelp(HELP), custom: parseCustomModels(SETTINGS) });
