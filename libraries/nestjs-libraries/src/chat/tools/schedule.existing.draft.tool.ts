import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import {
  ScheduleExistingDraftService,
  SchedulingWorkflowStarter,
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
      async start({ postId, orgId }) {
        await temporal.client.getRawClient()?.workflow.start('postWorkflowV112', {
          workflowId: `post_${postId}`,
          taskQueue: 'main',
          // never spawn a second workflow for the same post — a repeat
          // call attaches to / replaces via deterministic workflowId only
          // after the DB transition already guaranteed single ownership
          workflowIdConflictPolicy: 'FAIL',
          args: [{ taskQueue: 'main', postId, organizationId: orgId }],
          typedSearchAttributes: new TypedSearchAttributes([
            { key: postIdSearchParam, value: postId },
            { key: organizationId, value: orgId },
          ]),
        });
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
- The draft content must match the approved version exactly; an edited draft is rejected and needs re-approval.
- Requires a future UTC publish date and an approval reference from the conversation.
- The transition is atomic and safe to retry: a repeated call reports "no longer a draft" instead of double-scheduling.
- If the scheduling workflow fails to start, the post is reverted to DRAFT and the call reports an error — safe to retry.

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
