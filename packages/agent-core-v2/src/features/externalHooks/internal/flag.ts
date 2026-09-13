import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const HOOK_PERMISSION_DECISIONS_FLAG_ID = 'hook_permission_decisions';
export const HOOK_PERMISSION_DECISIONS_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_HOOK_PERMISSION_DECISIONS';

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
