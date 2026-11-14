import type { UpdateSessionRequestBody } from '@factory/droid-sdk/api';
import { Refused } from './config.ts';
import { checkEffort, checkModel, type ModelCatalog } from './models.ts';

export const EFFORTS = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type RunSettings = {
  model?: string;
  reasoningEffort?: Effort;
  specModel?: string;
  specReasoningEffort?: Effort;
  useSpec?: boolean;
  mission?: boolean;
  workerModel?: string;
  workerReasoningEffort?: Effort;
  validatorModel?: string;
  validatorReasoningEffort?: Effort;
  tags?: string[];
  worktree?: boolean | string;
  onlyTools?: string[];
  addTools?: string[];
  removeTools?: string[];
  appendSystemPrompt?: string;
  fork?: string;
};

export type SettingsUpdate = {
  modelId?: string;
  reasoningEffort?: Effort;
  specModeModelId?: string;
  specModeReasoningEffort?: Effort;
  interactionMode?: 'mission' | 'spec';
  autonomyLevel?: string;
  missionSettings?: {
    workerModel?: string;
    workerReasoningEffort?: Effort;
    validationWorkerModel?: string;
    validationWorkerReasoningEffort?: Effort;
  };
  tags?: Array<{ name: string; metadata?: Record<string, string> }>;
  restrictToolIds?: string[];
  additionalToolIds?: string[];
  disabledToolIds?: string[];
};
export type RestSessionSettings = NonNullable<UpdateSessionRequestBody['sessionSettings']>;

const MISSION_ONLY = ['workerModel', 'workerReasoningEffort', 'validatorModel', 'validatorReasoningEffort'] as const;
const START_ONLY = ['appendSystemPrompt', 'worktree', 'fork'] as const;
const REST_IGNORED = ['mission', ...MISSION_ONLY, 'tags', ...START_ONLY] as const;

function defined<T extends object>(o: T): Partial<T> | undefined {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined);
  return entries.length ? (Object.fromEntries(entries) as Partial<T>) : undefined;
}

function setKeys(s: RunSettings, keys: readonly (keyof RunSettings)[]): string[] {
  return keys.filter((k) => s[k] !== undefined);
}

export function validateSettings(s: RunSettings, autonomy: string | undefined, catalog: ModelCatalog): void {
  for (const id of [s.model, s.specModel, s.workerModel, s.validatorModel]) if (id !== undefined) checkModel(id, catalog);
  const effort = (e: Effort | undefined, model: string | undefined) => {
    if (e !== undefined && model !== undefined) checkEffort(e, model, catalog);
  };
  effort(s.reasoningEffort, s.model);
  effort(s.specReasoningEffort, s.specModel ?? s.model);
  effort(s.workerReasoningEffort, s.workerModel);
  effort(s.validatorReasoningEffort, s.validatorModel);
  const missionOnly = setKeys(s, MISSION_ONLY);
  if (!s.mission && missionOnly.length) throw new Refused('invalid', `${missionOnly.join(', ')} need mission: true`, 'Add mission: true, or drop those settings.');
  if (s.mission && s.useSpec) throw new Refused('invalid', 'mission and useSpec cannot be combined', 'Pass only one of mission and useSpec.');
  if (s.mission && autonomy !== 'high') throw new Refused('invalid', 'mission mode requires autonomy "high"', 'Pass autonomy "high" with mission: true.');
}

export function startOnly(s: RunSettings): string[] {
  return setKeys(s, START_ONLY);
}

export function toUpdate(s: RunSettings): SettingsUpdate | undefined {
  return defined({
    modelId: s.model,
    reasoningEffort: s.reasoningEffort,
    specModeModelId: s.specModel,
    specModeReasoningEffort: s.specReasoningEffort,
    interactionMode: s.mission ? ('mission' as const) : s.useSpec ? ('spec' as const) : undefined,
    missionSettings: defined({
      workerModel: s.workerModel,
      workerReasoningEffort: s.workerReasoningEffort,
      validationWorkerModel: s.validatorModel,
      validationWorkerReasoningEffort: s.validatorReasoningEffort,
    }),
    restrictToolIds: s.onlyTools,
    additionalToolIds: s.addTools,
    disabledToolIds: s.removeTools,
  });
}

export function toRestSettings(s: RunSettings): { sessionSettings: RestSessionSettings; ignored: string[] } {
  const sessionSettings: RestSessionSettings =
    defined({
      model: s.model,
      reasoningEffort: s.reasoningEffort,
      specModeModel: s.specModel,
      specModeReasoningEffort: s.specReasoningEffort,
      interactionMode: s.useSpec ? ('spec' as const) : undefined,
      restrictToolIds: s.onlyTools,
      enabledToolIds: s.addTools,
      disabledToolIds: s.removeTools,
    }) ?? {};
  return { sessionSettings, ignored: setKeys(s, REST_IGNORED) };
}

// Adds tag names without dropping the metadata of tags the session already has.
export function addTags(existing: SettingsUpdate['tags'] = [], names: string[]): NonNullable<SettingsUpdate['tags']> {
  const have = new Set(existing.map((t) => t.name));
  return [...existing, ...[...new Set(names)].filter((n) => !have.has(n)).map((name) => ({ name }))];
}
