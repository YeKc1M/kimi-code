import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const HOOK_PERMISSION_DECISIONS_FLAG_ID = 'hook_permission_decisions';
export const HOOK_PERMISSION_DECISIONS_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_HOOK_PERMISSION_DECISIONS';

/**
 * Gates blocking PermissionRequest hook decisions: when enabled, matching
 * `PermissionRequest` hooks run before the approval broker and may approve or
 * deny the tool call via `hookSpecificOutput.permissionDecision`; when
 * disabled, `PermissionRequest` stays observation-only. Off by default;
 * enable via `KIMI_CODE_EXPERIMENTAL_HOOK_PERMISSION_DECISIONS`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 */
export const hookPermissionDecisionsFlag: FlagDefinitionInput = {
  id: HOOK_PERMISSION_DECISIONS_FLAG_ID,
  title: 'PermissionRequest hook decisions',
  description:
    'Run matching PermissionRequest hooks before the approval broker and honor their hookSpecificOutput.permissionDecision ("allow" / "deny") as the tool-call approval decision. When off, PermissionRequest hooks remain observation-only.',
  env: HOOK_PERMISSION_DECISIONS_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(hookPermissionDecisionsFlag);
