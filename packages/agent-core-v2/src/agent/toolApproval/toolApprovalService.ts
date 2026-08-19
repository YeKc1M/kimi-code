/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
/**
 * `toolApproval` domain — `IAgentToolApprovalService` implementation.
 *
 * Owns the approval round-trip: dispatches
 * `permission.approval.requested/resolved` as Event2 records through
 * `dispatcher`, awaits the session approval broker (absent broker =
 * auto-approve), records session-scope approval rules through
 * `permissionRules`, reports `permission_approval_result` through
 * `telemetry`, and folds ask continuations back into authorize results.
 * Behind the `hook_permission_decisions` flag (resolved through `flag`),
 * matching `PermissionRequest` hooks run first through
 * `externalHooksRunner` and an explicit allow/deny decision replaces the
 * broker round-trip. The interaction id is minted here (`approval_<uuid>`)
 * so the broker, the events, and the activity view all key the same
 * request. Bound at Agent scope.
 */
import { randomUUID } from 'node:crypto';

import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable, isUserCancellation } from '#/_base/utils/abort';
import { HOOK_PERMISSION_DECISIONS_FLAG_ID } from '#/agent/externalHooks/flag';
import type { HookResult } from '#/agent/externalHooks/types';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  ApprovalResponse,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { Event2 } from '#/app/event/event2';
import { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import { permissionDecisionFromResults } from '#/app/externalHooksRunner/runner';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { IAgentToolApprovalService } from './toolApproval';

export interface PermissionApprovalRequestedPayload {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
  readonly toolInput: unknown;
}

export class PermissionApprovalRequested extends Event2<PermissionApprovalRequestedPayload> {
  static override readonly type = 'permission.approval.requested';
  static override readonly observable = true;
}
export interface PermissionApprovalRequested extends PermissionApprovalRequestedPayload {}

export interface PermissionApprovalResolvedPayload extends PermissionApprovalRequestedPayload {
  readonly decision: 'approved' | 'rejected' | 'cancelled' | 'error';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
  readonly error?: string;
}

export class PermissionApprovalResolved extends Event2<PermissionApprovalResolvedPayload> {
  static override readonly type = 'permission.approval.resolved';
  static override readonly observable = true;
}
export interface PermissionApprovalResolved extends PermissionApprovalResolvedPayload {}

export class AgentToolApprovalService extends Service implements IAgentToolApprovalService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @ISessionContext private readonly session: ISessionContext,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IExternalHooksRunnerService private readonly hooksRunner: IExternalHooksRunnerService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super();
  }

  async resolvePermissionResolution(
    result: PermissionPolicyResolution,
    context: ResolvedToolExecutionHookContext,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined> {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          veto: denyToolExecution(
            this.formatDenyMessage(
              result.message ?? `Tool "${context.toolCall.name}" was denied by permission policy.`,
            ),
          ),
        };
      case 'ask':
        return this.requestToolApproval(context, result, origin);
      case 'result':
        return { veto: result.result };
    }
  }

  async requestToolApproval(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined> {
    const name = context.toolCall.name;
    const action = context.execution.description ?? `Approve ${name}`;
    const display =
      context.execution.display ??
      ({
        kind: 'generic',
        summary: action,
        detail: context.args,
      } as ToolInputDisplay);
    const approvalRequest = {
      id: `approval_${randomUUID()}`,
      sessionId: this.session.sessionId,
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: name,
      action,
      display,
    };
    const approvalContext = {
      ...approvalRequest,
      toolInput: context.args,
    } satisfies PermissionApprovalRequestedPayload;
    const startedAt = Date.now();

    let response: ApprovalResponse;
    const approvalService = this.tryApprovalService();
    if (approvalService === undefined) {
      response = { decision: 'approved' };
    } else {
      const hookDecision = await this.requestHookPermissionDecision(approvalContext, context);
      if (hookDecision !== undefined) {
        void this.dispatcher.dispatch(new PermissionApprovalRequested(approvalContext));
        response = hookDecision;
      } else {
        void this.dispatcher.dispatch(new PermissionApprovalRequested(approvalContext));
        try {
          response = await abortable(
            approvalService.request(approvalRequest),
            context.signal,
          );
          context.signal.throwIfAborted();
        } catch (error) {
          if (isUserCancellation(error)) throw error;
          this.telemetry.track2('permission_approval_result', {
            turn_id: context.turnId,
            tool_call_id: context.toolCall.id,
            policy_name: origin,
            tool_name: name,
            permission_mode: this.modeService.mode,
            result: 'error',
            approval_surface: display.kind,
            duration_ms: Date.now() - startedAt,
            session_cache_written: false,
            has_feedback: false,
            trace_id: context.trace?.traceId,
          });
          void this.dispatcher.dispatch(
            new PermissionApprovalResolved({
              ...approvalContext,
              decision: 'error',
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          const resolved = result.resolveError?.(error);
          if (resolved !== undefined) {
            return this.resolvePermissionResolution(resolved, context, origin);
          }
          throw error;
        }
      }
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;
    if (approvalService !== undefined) {
      void this.dispatcher.dispatch(
        new PermissionApprovalResolved({
          ...approvalContext,
          ...response,
        }),
      );
    }
    this.rulesService.recordApprovalResult({
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });
    this.telemetry.track2('permission_approval_result', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      policy_name: origin,
      tool_name: name,
      permission_mode: this.modeService.mode,
      result:
        response.decision === 'approved' && response.scope === 'session'
          ? 'approved_for_session'
          : response.decision,
      approval_surface: display.kind,
      duration_ms: Date.now() - startedAt,
      session_cache_written: sessionApprovalRule !== undefined,
      has_feedback: response.feedback !== undefined && response.feedback.length > 0,
      trace_id: context.trace?.traceId,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.resolvePermissionResolution(resolved, context, origin);
    }

    if (response.decision === 'approved') return undefined;
    return {
      veto: denyToolExecution(this.formatApprovalRejectionMessage(name, response)),
    };
  }

  formatApprovalRejectionMessage(
    toolName: string,
    result: Pick<ApprovalResponse, 'decision' | 'feedback'>,
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.usesWorkerRejectionGuidance()) {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  formatDenyMessage(message: string): string {
    if (this.usesWorkerRejectionGuidance()) {
      return `${message} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return message;
  }

  private async requestHookPermissionDecision(
    approvalContext: PermissionApprovalRequestedPayload,
    context: ResolvedToolExecutionHookContext,
  ): Promise<ApprovalResponse | undefined> {
    if (!this.flags.enabled(HOOK_PERMISSION_DECISIONS_FLAG_ID)) return undefined;
    if (!this.hooksRunner.hasHooksFor('PermissionRequest')) return undefined;
    let results: HookResult[];
    try {
      results = await this.hooksRunner.trigger('PermissionRequest', {
        matcherValue: context.toolCall.name,
        inputData: { ...approvalContext },
        sessionId: this.session.sessionId,
        signal: context.signal,
      });
    } catch {
      return undefined;
    }
    context.signal.throwIfAborted();
    const decision = permissionDecisionFromResults(results);
    if (decision === undefined) return undefined;
    return decision.decision === 'allow'
      ? { decision: 'approved' }
      : { decision: 'rejected', feedback: decision.reason };
  }

  private tryApprovalService(): ISessionApprovalService | undefined {
    try {
      return this.instantiation.invokeFunction(
        (accessor) => accessor.get(ISessionApprovalService) as ISessionApprovalService | undefined,
      );
    } catch {
      return undefined;
    }
  }

  private usesWorkerRejectionGuidance(): boolean {
    return this.scopeContext.agentId !== 'main';
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolApprovalService,
  AgentToolApprovalService,
  ScopeActivation.OnScopeCreated,
  'toolApproval',
);
