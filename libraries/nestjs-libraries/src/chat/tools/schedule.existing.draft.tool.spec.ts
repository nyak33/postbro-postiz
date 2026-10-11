import { ScheduleExistingDraftService } from './schedule.existing.draft.service';

// Deterministic unit tests — in-memory fakes for repository, integration
// service, workflow starter and platform validation. No DB, no Temporal.

const POST_ID = 'post_123';
const ORG_ID = 'org_1';
const INTEGRATION_ID = 'int_1';

const makePost = (overrides: any = {}) => ({
  id: POST_ID,
  organizationId: ORG_ID,
  integrationId: INTEGRATION_ID,
  state: 'DRAFT',
  publishDate: new Date('2026-10-11T09:30:00Z'),
  content: '<p>hello</p>',
  settings: '{}',
  ...overrides,
});

const makeService = (opts: {
  post?: any;
  integration?: any;
  conditionalResult?: number;
  workflowFails?: boolean;
  validateResult?: any;
}) => {
  const calls: any = { start: [], revert: [] };
  const repository: any = {
    getPostById: jest
      .fn()
      .mockImplementation((id: string, org?: string) =>
        Promise.resolve(
          opts.post === null || org !== ORG_ID
            ? null
            : { ...makePost(), ...(opts.post || {}) }
        )
      ),
    conditionalScheduleDraft: jest
      .fn()
      .mockResolvedValue(opts.conditionalResult ?? 1),
    revertToDraft: jest.fn().mockImplementation((org: string, id: string) => {
      calls.revert.push([org, id]);
      return Promise.resolve(1);
    }),
  };
  const integrationService: any = {
    getIntegrationById: jest.fn().mockResolvedValue(
      opts.integration === null
        ? null
        : {
            id: INTEGRATION_ID,
            organizationId: ORG_ID,
            providerIdentifier: 'threads',
            disabled: false,
            deletedAt: null,
            ...(opts.integration || {}),
          }
    ),
  };
  const starter: any = {
    start: jest.fn().mockImplementation((args: any) => {
      calls.start.push(args);
      if (opts.workflowFails) return Promise.reject(new Error('temporal down'));
      return Promise.resolve();
    }),
  };
  const validate = jest.fn().mockResolvedValue([
    opts.validateResult === undefined
      ? { valid: true, errors: true, emptyContent: false, tooLong: false }
      : opts.validateResult,
  ]);

  const service = new ScheduleExistingDraftService(
    repository,
    integrationService,
    starter,
    validate as any
  );
  return { service, repository, starter, calls };
};

const validInput = (overrides: any = {}) => ({
  orgId: ORG_ID,
  postId: POST_ID,
  integrationId: INTEGRATION_ID,
  publishDateUtc: '2099-01-01T09:00:00Z',
  expectedContent: '<p>hello</p>',
  approvalRef: 'appr_test_1',
  ...overrides,
});

describe('ScheduleExistingDraftService', () => {
  it('schedules an existing DRAFT in place, retaining the same post ID and correct UTC date', async () => {
    const { service, repository, calls } = makeService({});
    const res = await service.schedule(validInput());
    expect(res.postId).toBe(POST_ID);
    expect(res.integrationId).toBe(INTEGRATION_ID);
    expect(res.state).toBe('QUEUE');
    expect(res.publishDate).toBe('2099-01-01T09:00:00.000Z');
    expect(repository.conditionalScheduleDraft).toHaveBeenCalledWith(
      ORG_ID,
      POST_ID,
      new Date('2099-01-01T09:00:00Z')
    );
    expect(calls.start.length).toBe(1);
    expect(calls.start[0].postId).toBe(POST_ID);
  });

  it('rejects when the post is not found (wrong org or bad id)', async () => {
    const { service } = makeService({ post: null });
    await expect(service.schedule(validInput())).rejects.toThrow(/not found/i);
  });

  it('rejects when the integration does not match the post', async () => {
    const { service, repository } = makeService({});
    await expect(
      service.schedule(validInput({ integrationId: 'int_other' }))
    ).rejects.toThrow(/integration/i);
    expect(repository.conditionalScheduleDraft).not.toHaveBeenCalled();
  });

  it('rejects a disabled / disconnected integration', async () => {
    const { service } = makeService({ integration: { disabled: true } });
    await expect(service.schedule(validInput())).rejects.toThrow(
      /not connected/i
    );
  });

  it('rejects PUBLISHED posts', async () => {
    const { service, repository } = makeService({
      post: { state: 'PUBLISHED' },
    });
    await expect(service.schedule(validInput())).rejects.toThrow(/draft/i);
    expect(repository.conditionalScheduleDraft).not.toHaveBeenCalled();
  });

  it('rejects already-QUEUED posts', async () => {
    const { service } = makeService({ post: { state: 'QUEUE' } });
    await expect(service.schedule(validInput())).rejects.toThrow(/draft/i);
  });

  it('rejects a draft modified after approval (content mismatch)', async () => {
    const { service, repository } = makeService({});
    await expect(
      service.schedule(validInput({ expectedContent: '<p>tampered</p>' }))
    ).rejects.toThrow(/content/i);
    expect(repository.conditionalScheduleDraft).not.toHaveBeenCalled();
  });

  it('rejects past dates', async () => {
    const { service } = makeService({});
    await expect(
      service.schedule(validInput({ publishDateUtc: '2020-01-01T00:00:00Z' }))
    ).rejects.toThrow(/future/i);
  });

  it('rejects invalid date strings', async () => {
    const { service } = makeService({});
    await expect(
      service.schedule(validInput({ publishDateUtc: 'not-a-date' }))
    ).rejects.toThrow(/invalid/i);
  });

  it('rejects content failing platform validation (too long)', async () => {
    const { service, repository } = makeService({
      validateResult: {
        valid: true,
        errors: true,
        emptyContent: false,
        tooLong: true,
      },
    });
    await expect(service.schedule(validInput())).rejects.toThrow(/length/i);
    expect(repository.conditionalScheduleDraft).not.toHaveBeenCalled();
  });

  it('repeated approval: conditional update returns 0 → "no longer a draft", no workflow start', async () => {
    const { service, calls } = makeService({ conditionalResult: 0 });
    await expect(service.schedule(validInput())).rejects.toThrow(
      /no longer a draft/i
    );
    expect(calls.start.length).toBe(0);
  });

  it('concurrent approvals: exactly one winner proceeds', async () => {
    const winner = makeService({ conditionalResult: 1 });
    const loser = makeService({ conditionalResult: 0 });
    const results = await Promise.allSettled([
      winner.service.schedule(validInput()),
      loser.service.schedule(validInput()),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as any).reason.message).toMatch(/no longer a draft/i);
  });

  it('workflow startup failure after persistence → conditional revert to DRAFT + actionable error', async () => {
    const { service, calls } = makeService({ workflowFails: true });
    await expect(service.schedule(validInput())).rejects.toThrow(
      /workflow startup failed.*reverted to DRAFT.*retry/i
    );
    expect(calls.revert.length).toBe(1);
    expect(calls.revert[0]).toEqual([ORG_ID, POST_ID]);
  });

  it('missing approval reference is rejected', async () => {
    const { service, repository } = makeService({});
    await expect(
      service.schedule(validInput({ approvalRef: '  ' }))
    ).rejects.toThrow(/approval/i);
    expect(repository.conditionalScheduleDraft).not.toHaveBeenCalled();
  });
});
