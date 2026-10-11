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

/**
 * Minimal, injectable wrapper around the Temporal client used only for
 * scheduling workflows. In production it is bound to TemporalService;
 * tests bind a stub. start() must throw on failure.
 */
export abstract class SchedulingWorkflowStarter {
  abstract start(input: {
    postId: string;
    orgId: string;
    taskQueue: string;
  }): Promise<void>;
}

/**
 * Pure, dependency-explicit service for the scheduleExistingDraftTool.
 * Deliberately does NOT reuse changePostStatus/changeDate (see checkpoint 2C):
 * the transition here is a single conditional UPDATE guarded on
 * state='DRAFT' AND organizationId, executed after content verification.
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

    // Content version check — a draft edited after approval must never
    // be scheduled under the old approval.
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

    // Atomic, conditional DRAFT -> QUEUE transition. updateMany with a
    // state='DRAFT' predicate: returns 1 to exactly one concurrent caller;
    // everyone else gets 0 (idempotency + concurrency safety in the DB).
    const updated = await this._postsRepository.conditionalScheduleDraft(
      orgId,
      postId,
      publishDate.toDate()
    );
    if (updated === 0) {
      throw new BadRequestException(
        'Post is no longer a draft (already scheduled or modified by another request). No changes were made.'
      );
    }

    // Persistence committed — start the scheduling workflow. If startup
    // fails, reconcile by reverting the row to DRAFT so a broken schedule
    // never sits in QUEUE without a workflow behind it.
    try {
      await this._workflowStarter.start({
        postId,
        orgId,
        taskQueue: integration.providerIdentifier.split('-')[0].toLowerCase(),
      });
    } catch (err: any) {
      await this._postsRepository.revertToDraft(orgId, postId);
      throw new BadRequestException(
        `Schedule saved but workflow startup failed (${err?.message || 'unknown'}). The post was reverted to DRAFT — safe to retry.`
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
