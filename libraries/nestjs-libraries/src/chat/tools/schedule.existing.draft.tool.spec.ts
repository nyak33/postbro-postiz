import { ScheduleExistingDraftService } from './schedule.existing.draft.service';
import { WorkflowAlreadyStartedError } from './schedule.existing.draft.service';
import { ScheduleExistingDraftTool } from './schedule.existing.draft.tool';

jest.mock('@gitroom/nestjs-libraries/database/prisma/posts/posts.repository', () => ({ PostsRepository: class {} }));
jest.mock('@gitroom/nestjs-libraries/database/prisma/integrations/integration.service', () => ({ IntegrationService: class {} }));
jest.mock('@gitroom/nestjs-libraries/database/prisma/posts/posts.service', () => ({ PostsService: class {} }));
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

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
  workflowError?: Error | null;
  describeResult?: 'running' | 'not-found' | 'unknown';
  validateResult?: any;
}) => {
  const calls: any = { start: [], revert: [], describe: [] };
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
      if (opts.workflowError) return Promise.reject(opts.workflowError);
      return Promise.resolve('started');
    }),
    describe: jest.fn().mockImplementation((postId: string) => {
      calls.describe.push(postId);
      return Promise.resolve(opts.describeResult ?? 'not-found');
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
    // F10: content equality is part of the atomic predicate
    expect(repository.conditionalScheduleDraft).toHaveBeenCalledWith(
      ORG_ID,
      POST_ID,
      new Date('2099-01-01T09:00:00Z'),
      '<p>hello</p>'
    );
    expect(calls.start.length).toBe(1);
    expect(calls.start[0].postId).toBe(POST_ID);
    // F9: provider-specific activity task queue forwarded to the workflow args
    expect(calls.start[0].taskQueue).toBe('threads');
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

  it('repeated approval: conditional update returns 0 → "no longer schedulable", no workflow start', async () => {
    const { service, calls } = makeService({ conditionalResult: 0 });
    await expect(service.schedule(validInput())).rejects.toThrow(
      /no longer schedulable/i
    );
    expect(calls.start.length).toBe(0);
  });

  it('F10: concurrent content edit makes the atomic predicate return 0 even when pre-check passed', async () => {
    const { service, calls } = makeService({ conditionalResult: 0 });
    await expect(service.schedule(validInput())).rejects.toThrow(
      /no longer schedulable.*content changed concurrently|content changed concurrently/i
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
    expect((failed[0] as any).reason.message).toMatch(
      /no longer schedulable/i
    );
  });

  it('F4: WorkflowExecutionAlreadyStartedError → post stays QUEUE, no revert, actionable non-retry error', async () => {
    const { service, calls } = makeService({
      workflowError: new WorkflowAlreadyStartedError('already started'),
    });
    await expect(service.schedule(validInput())).rejects.toThrow(
      /already exists.*stays QUEUE.*do NOT retry/i
    );
    expect(calls.revert.length).toBe(0);
    expect(calls.describe.length).toBe(0);
  });

  it('temporal ambiguity: start throws but workflow is RUNNING → report success, no revert', async () => {
    const { service, calls } = makeService({
      workflowError: new Error('network timeout'),
      describeResult: 'running',
    });
    const res = await service.schedule(validInput());
    expect(res.state).toBe('QUEUE');
    expect(calls.describe).toEqual([POST_ID]);
    expect(calls.revert.length).toBe(0);
  });

  it('temporal ambiguity: start throws and workflow confirmed NOT-FOUND → revert to DRAFT, safe-to-retry error', async () => {
    const { service, calls } = makeService({
      workflowError: new Error('temporal down'),
      describeResult: 'not-found',
    });
    await expect(service.schedule(validInput())).rejects.toThrow(
      /reverted to DRAFT.*safe to retry/i
    );
    expect(calls.revert).toEqual([[ORG_ID, POST_ID]]);
  });

  it('temporal ambiguity: status UNKNOWN → left in QUEUE, manual-check instructions, no blind revert', async () => {
    const { service, calls } = makeService({
      workflowError: new Error('connection reset'),
      describeResult: 'unknown',
    });
    await expect(service.schedule(validInput())).rejects.toThrow(
      /could not be determined.*left in QUEUE.*Check workflow post_post_123/i
    );
    expect(calls.revert.length).toBe(0);
  });

  it('missing approval reference is rejected', async () => {
    const { service, repository } = makeService({});
    await expect(
      service.schedule(validInput({ approvalRef: '  ' }))
    ).rejects.toThrow(/approval/i);
    expect(repository.conditionalScheduleDraft).not.toHaveBeenCalled();
  });
});

// F5: exercise the REAL starter adapter from the tool (not a service-level
// mock) against a stubbed TemporalService, verifying client-availability
// guard, workflow payload and error mapping.
describe('ScheduleExistingDraftTool real starter adapter', () => {
  const makeTool = (rawClient: any) => {
    const temporal: any = {
      client: { getRawClient: () => rawClient },
    };
    const tool = new ScheduleExistingDraftTool(
      {} as any,
      {} as any,
      {} as any,
      temporal
    );
    // reach the private builder the same way execute() does
    const service = (tool as any).buildService();
    return service._workflowStarter;
  };

  it('F5: throws when the Temporal client is unavailable', async () => {
    const starter = makeTool(undefined);
    await expect(
      starter.start({ postId: 'p1', orgId: 'o1', taskQueue: 'threads' })
    ).rejects.toThrow(/Temporal client is not available/i);
  });

  it('F9: start payload — workflow on main queue, provider queue inside args', async () => {
    const startArgs: any[] = [];
    const raw = {
      workflow: {
        start: jest.fn().mockImplementation((_t: string, o: any) => {
          startArgs.push(o);
          return Promise.resolve({});
        }),
      },
    };
    const starter = makeTool(raw);
    const res = await starter.start({
      postId: 'p1',
      orgId: 'o1',
      taskQueue: 'threads',
    });
    expect(res).toBe('started');
    expect(startArgs[0].taskQueue).toBe('main');
    expect(startArgs[0].workflowId).toBe('post_p1');
    expect(startArgs[0].workflowIdConflictPolicy).toBe('FAIL');
    expect(startArgs[0].args[0]).toEqual({
      taskQueue: 'threads',
      postId: 'p1',
      organizationId: 'o1',
    });
  });

  it('F4: adapter maps WorkflowExecutionAlreadyStartedError by name', async () => {
    const err = new Error('workflow execution already started');
    err.name = 'WorkflowExecutionAlreadyStartedError';
    const raw = { workflow: { start: jest.fn().mockRejectedValue(err) } };
    const starter = makeTool(raw);
    await expect(
      starter.start({ postId: 'p1', orgId: 'o1', taskQueue: 'threads' })
    ).rejects.toThrow(WorkflowAlreadyStartedError);
  });

  it('describe: RUNNING → running, WorkflowNotFoundError → not-found, other errors → unknown, no client → unknown', async () => {
    const running = makeTool({
      workflow: {
        getHandle: () => ({
          describe: () => Promise.resolve({ status: { name: 'RUNNING' } }),
        }),
      },
    });
    expect(await running.describe('p1')).toBe('running');

    const nfErr = new Error('not found');
    nfErr.name = 'WorkflowNotFoundError';
    const notFound = makeTool({
      workflow: { getHandle: () => ({ describe: () => Promise.reject(nfErr) }) },
    });
    expect(await notFound.describe('p1')).toBe('not-found');

    const boom = makeTool({
      workflow: {
        getHandle: () => ({
          describe: () => Promise.reject(new Error('unavailable')),
        }),
      },
    });
    expect(await boom.describe('p1')).toBe('unknown');

    const noClient = makeTool(undefined);
    expect(await noClient.describe('p1')).toBe('unknown');
  });
});
