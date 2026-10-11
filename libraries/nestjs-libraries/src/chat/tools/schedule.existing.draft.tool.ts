import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import {
  ScheduleExistingDraftService,
  SchedulingWorkflowStarter,
  WorkflowAlreadyStartedError,
} from '@gitroom/nestjs-libraries/chat/tools/schedule.existing.draft.service';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { TemporalService } from 'nestjs-temporal-core';
import { TypedSearchAttributes } from '@temporalio/common';
import {
  postId as postIdSearchParam,
  organizationId,
} from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';

@Injectable()
export class ScheduleExistingDraftTool implements AgentToolInterface {
  constructor(
    private _postsService: PostsService,
    private _postsRepository: PostsRepository,
    private _integrationService: IntegrationService,
    private _temporalService: TemporalService
  ) {}

  name = 'scheduleExistingDraftTool';
  // scheduling is a write operation with real side effects — MCP only,
  // never offered to the in-app agent
  mcpOnly = true;

  private buildService() {
    const temporal = this._temporalService;
    const starter: SchedulingWorkflowStarter = {
      async start({ postId, orgId, taskQueue }) {
        // F5: never silently no-op. getRawClient() may be undefined when
        // Temporal isn't connected — optional chaining would make start()
        // resolve without creating anything.
        const raw = temporal.client.getRawClient();
        if (!raw) {
          throw new Error(
            'Temporal client is not available — scheduling workflow cannot be started'
          );
        }
        // Mirrors PostsService.startWorkflow: the workflow itself always
        // runs on the 'main' task queue; the provider-specific queue is
        // passed in args[0].taskQueue and used by postWorkflowV112 to route
        // its ACTIVITIES (workers register per provider prefix in
        // temporal.module.ts).
        try {
          await raw.workflow.start('postWorkflowV112', {
            workflowId: `post_${postId}`,
            taskQueue: 'main',
            // deterministic id: a duplicate start throws
            // WorkflowExecutionAlreadyStartedError (mapped in the service)
            workflowIdConflictPolicy: 'FAIL',
            args: [{ taskQueue, postId, organizationId: orgId }],
            typedSearchAttributes: new TypedSearchAttributes([
              { key: postIdSearchParam, value: postId },
              { key: organizationId, value: orgId },
            ]),
          });
        } catch (err: any) {
          if (err?.name === 'WorkflowExecutionAlreadyStartedError') {
            throw new WorkflowAlreadyStartedError(err.message);
          }
          throw err;
        }
        return 'started' as const;
      },
      async describe(postId) {
        try {
          const raw = temporal.client.getRawClient();
          if (!raw) return 'unknown';
          const handle = raw.workflow.getHandle(`post_${postId}`);
          const desc = await handle.describe();
          // F11: the workflow EXISTS regardless of its run status. Only a
          // genuine WorkflowNotFoundError (catch below) means it was never
          // accepted. COMPLETED/FAILED/CANCELLED/TERMINATED/TIMED_OUT all
          // mean the workflow ran — never treat as absent (a blind revert
          // could then strand real publish side-effects or history).
          return desc.status.name === 'RUNNING' ? 'running' : 'exists-not-running';
        } catch (err: any) {
          if (err?.name === 'WorkflowNotFoundError') return 'not-found';
          return 'unknown';
        }
      },
    };

    return new ScheduleExistingDraftService(
      this._postsRepository,
      this._integrationService,
      starter,
      (orgId, post) =>
        this._postsService.validatePosts(orgId, [
          {
            integration: { id: post.integrationId },
            value: [{ content: post.content, image: (post as any).image || [] }],
            settings:
              typeof post.settings === 'string'
                ? JSON.parse(post.settings || '{}')
                : post.settings || {},
          },
        ]) as any
    );
  }

  run() {
    return createTool({
      id: 'scheduleExistingDraftTool',
      mcp: {
        annotations: {
          title: 'Schedule Existing Draft',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      description: `
Schedule an EXISTING unpublished draft in place (same post ID, no new post is created).
Use this only after explicit user approval for a specific date/time — saving a draft is NOT approval to schedule.

Hard guarantees:
- Only works on posts currently in DRAFT state. PUBLISHED or already-scheduled (QUEUE) posts are rejected.
- The draft content must match the approved version exactly, checked atomically with the scheduling update; an edited draft is rejected and needs re-approval.
- Requires a future UTC publish date.
- approvalRef is an AUDIT reference to an out-of-band approval (e.g. an approval ledger id), required for traceability. It is NOT verified by the server and is NOT an authorization mechanism — access control is the MCP API key.
- The transition is atomic and safe to retry: a repeated call reports the post is no longer schedulable instead of double-scheduling.
- If workflow startup fails, the workflow status is checked before any rollback: confirmed-absent → post reverted to DRAFT (safe to retry); status indeterminable → post left in QUEUE with manual-check instructions (never blindly rolled back).

Find drafts first with postsListTool. To change provider settings before scheduling, use postSettingsTool.
`,
      inputSchema: z.object({
        postId: z.string().describe('The id of the existing draft post'),
        integrationId: z
          .string()
          .describe('The integration the draft belongs to (verified against the post)'),
        publishDateUtc: z
          .string()
          .describe('Publishing date/time in UTC ISO 8601 (must be in the future), e.g. 2026-10-12T01:00:00Z'),
        expectedContent: z
          .string()
          .describe('The exact current content of the draft as approved (fetched via postsListTool). Mismatch = rejected.'),
        approvalRef: z
          .string()
          .min(1)
          .describe('Reference to the explicit scheduling approval (e.g. approval ledger id)'),
      }),
      outputSchema: z.object({
        output: z
          .object({
            postId: z.string(),
            integrationId: z.string(),
            state: z.literal('QUEUE'),
            publishDate: z.string(),
          })
          .or(z.object({ errors: z.string() })),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organization = JSON.parse(
          (context?.requestContext as any)?.get('organization') as string
        );
        try {
          const output = await this.buildService().schedule({
            orgId: organization.id,
            postId: inputData.postId,
            integrationId: inputData.integrationId,
            publishDateUtc: inputData.publishDateUtc,
            expectedContent: inputData.expectedContent,
            approvalRef: inputData.approvalRef,
          });
          return { output };
        } catch (err: any) {
          return { output: { errors: err?.message || 'Failed to schedule draft' } };
        }
      },
    });
  }
}
