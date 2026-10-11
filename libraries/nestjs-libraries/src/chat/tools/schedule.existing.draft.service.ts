import { Injectable, BadRequestException } from '@nestjs/common';
import dayjs from 'dayjs';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';

export interface ScheduleExistingDraftRequest {
  orgId: string;
  postId: string;
  integrationId: string;
  publishDateUtc: string;
  expectedContent: string;
  approvalRef: string;
}

export interface ScheduleExistingDraftResult {
  postId: string;
  integrationId: string;
  state: 'QUEUE';
  publishDate: string;
}

export interface ValidatePostLike {
  valid: boolean;
  errors: string | true;
  emptyContent: boolean;
  tooLong: boolean;
}

export class WorkflowAlreadyStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowExecutionAlreadyStartedError';
  }
}

/**
 * Result of a workflow start attempt. 'started' is the only success.
 * 'uncertain' means the start call failed with a transport-level error and
 * the workflow MAY have been accepted by the server — the caller must
 * reconcile by querying workflow status instead of blindly rolling back.
 */
export interface SchedulingWorkflowStarter {
  start(input: {
    postId: string;
    orgId: string;
    taskQueue: string;
  }): Promise<'started'>;
  /**
   * Best-effort status check used when start() threw with an ambiguous
   * transport error. Returns 'running' | 'not-found' | 'unknown'.
   */
  describe(postId: string): Promise<'running' | 'not-found' | 'unknown'>;
}

/**
 * Pure, dependency-explicit service for the scheduleExistingDraftTool.
 * Deliberately does NOT reuse changePostStatus/changeDate (see checkpoint 2C):
 * the transition here is a single conditional UPDATE guarded on
 * state='DRAFT', organizationId AND exact approved content, so a concurrent
 * edit between validation and the write invalidates the schedule.
 */
@Injectable()
export class ScheduleExistingDraftService {
  constructor(
    private _postsRepository: PostsRepository,
    private _integrationService: {
      getIntegrationById: (org: string, id: string) => Promise<any>;
    },
    private _workflowStarter: SchedulingWorkflowStarter,
    private _validate: (
      orgId: string,
      post: any
    ) => Promise<ValidatePostLike[]>
  ) {}

  async schedule(
    req: ScheduleExistingDraftRequest
  ): Promise<ScheduleExistingDraftResult> {
    const { orgId, postId, integrationId, approvalRef } = req;

    // approvalRef is an AUDIT reference to the out-of-band approval (e.g.
    // the Hermes approval ledger). It is required for traceability but is
    // NOT server-side authorization — see tool description.
    if (!approvalRef || !approvalRef.trim()) {
      throw new BadRequestException(
        'An explicit scheduling approval reference is required'
      );
    }

    const publishDate = dayjs(req.publishDateUtc);
    if (!publishDate.isValid()) {
      throw new BadRequestException(
        `Invalid publish date: ${req.publishDateUtc} (UTC ISO 8601 required)`
      );
    }
    if (!publishDate.isAfter(dayjs())) {
      throw new BadRequestException(
        'Publish date must be in the future (UTC)'
      );
    }

    // Ownership + current state (read for pre-checks; the write below is
    // the authoritative conditional transition).
    const post = await this._postsRepository.getPostById(postId, orgId);
    if (!post) {
      throw new BadRequestException(`Post with id ${postId} not found`);
    }
    if (post.state !== 'DRAFT') {
      throw new BadRequestException(
        `Post ${postId} is not a draft (current state: ${post.state}). Only DRAFT posts can be scheduled through this tool.`
      );
    }
    if (post.integrationId !== integrationId) {
      throw new BadRequestException(
        `Post ${postId} does not belong to integration ${integrationId}`
      );
    }

    const integration = await this._integrationService.getIntegrationById(
      orgId,
      integrationId
    );
    if (!integration || integration.disabled || integration.deletedAt) {
      throw new BadRequestException(
        `Integration ${integrationId} is not connected`
      );
    }

    // Content version pre-check (fast, clear error). The SAME equality is
    // repeated atomically in the conditional update below — that one is the
    // authoritative guard against concurrent edits.
    if (post.content !== req.expectedContent) {
      throw new BadRequestException(
        'Draft content has changed since approval. Re-approve the current content before scheduling.'
      );
    }

    // Platform requirements (provider DTO + media rules + length).
    const [validation] = await this._validate(orgId, post);
    if (validation) {
      if (!validation.valid) {
        throw new BadRequestException('Post settings fail validation');
      }
      if (validation.errors !== true) {
        throw new BadRequestException(
          typeof validation.errors === 'string'
            ? validation.errors
            : 'Post media fails validation'
        );
      }
      if (validation.emptyContent) {
        throw new BadRequestException('Post content is empty');
      }
      if (validation.tooLong) {
        throw new BadRequestException(
          'Post content exceeds the platform length limit'
        );
      }
    }

    // Atomic, conditional DRAFT -> QUEUE transition guarded on org, DRAFT
    // state AND exact approved content. Exactly one concurrent caller gets
    // count=1; everyone else — including a caller racing a content edit —
    // gets 0 and nothing changes.
    const updated = await this._postsRepository.conditionalScheduleDraft(
      orgId,
      postId,
      publishDate.toDate(),
      req.expectedContent
    );
    if (updated === 0) {
      throw new BadRequestException(
        'Post is no longer schedulable (already scheduled, or content changed concurrently). Re-fetch the draft and re-approve before retrying.'
      );
    }

    // Persistence committed — start the scheduling workflow.
    try {
      await this._workflowStarter.start({
        postId,
        orgId,
        taskQueue: integration.providerIdentifier.split('-')[0].toLowerCase(),
      });
    } catch (err: any) {
      // F4: a duplicate workflow id means a scheduling workflow for this
      // post already exists — do NOT revert; the post is correctly QUEUE
      // behind that workflow. Report it as a distinct, actionable state.
      if (err?.name === 'WorkflowExecutionAlreadyStartedError') {
        throw new BadRequestException(
          `Post was scheduled, but a workflow for it already exists (id post_${postId}). The post stays QUEUE. If that workflow is stale, terminate it in Temporal and re-schedule — do NOT retry this call blindly.`
        );
      }

      // Temporal ambiguity: a transport error can mean the workflow WAS
      // accepted. Blindly reverting to DRAFT would strand a live workflow
      // whose publish would then update a DRAFT post. Check status first.
      const status = await this._workflowStarter.describe(postId);
      if (status === 'running') {
        // Workflow exists — the schedule is actually live. Report honestly.
        return {
          postId,
          integrationId,
          state: 'QUEUE',
          publishDate: publishDate.toDate().toISOString(),
        };
      }
      if (status === 'not-found') {
        await this._postsRepository.revertToDraft(orgId, postId);
        throw new BadRequestException(
          `Workflow startup failed and no workflow exists (${err?.message || 'unknown'}). The post was reverted to DRAFT — safe to retry.`
        );
      }
      // 'unknown' — cannot determine. Fail safe: leave the post QUEUE and
      // tell the operator exactly what to check, no misleading retry.
      throw new BadRequestException(
        `Workflow startup failed (${err?.message || 'unknown'}) and workflow status could not be determined. The post was left in QUEUE to avoid stranding a possibly-live workflow. Check workflow post_${postId} in Temporal before retrying or reverting manually.`
      );
    }

    return {
      postId,
      integrationId,
      state: 'QUEUE',
      publishDate: publishDate.toDate().toISOString(),
    };
  }
}
