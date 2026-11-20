import { validate } from 'class-validator';
import type { Integration } from '@prisma/client';
import { ThreadsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/threads.dto';
import { ThreadsProvider } from '@gitroom/nestjs-libraries/integrations/social/threads.provider';

describe('Threads Topic Tags', () => {
  it.each(['', undefined, 'AI', 'Digital Marketing'])(
    'accepts optional valid topic %s',
    async (topicTag) => {
      const dto = Object.assign(new ThreadsDto(), { topic_tag: topicTag });
      expect(await validate(dto)).toHaveLength(0);
    }
  );

  it.each(['#AI', 'AI & ML', 'Tech.News', ' AI', 'AI ', 'a'.repeat(51)])(
    'rejects invalid topic %s',
    async (topicTag) => {
      const dto = Object.assign(new ThreadsDto(), { topic_tag: topicTag });
      expect(await validate(dto)).not.toHaveLength(0);
    }
  );

  function mockProvider() {
    const provider = new ThreadsProvider();
    const requests: Array<{ url: string; options?: RequestInit }> = [];
    jest
      .spyOn(provider as any, 'fetch')
      .mockImplementation(async (url: string, options?: RequestInit) => {
        requests.push({ url, options });
        return { json: async () => ({ id: 'test-container' }) };
      });
    return { provider, requests };
  }

  it('sends topic_tag on text containers', async () => {
    const { provider, requests } = mockProvider();
    await provider.postPending(
      'user-id',
      'access-token',
      [
        {
          id: 'post1',
          message: 'Hello',
          settings: { topic_tag: 'AI' },
          media: [],
        },
      ] as any,
      {} as Integration
    );

    expect((requests[0].options?.body as FormData).get('topic_tag')).toBe('AI');
  });

  it('sends topic_tag on single-image and video containers', async () => {
    for (const path of [
      'https://example.com/image.jpg',
      'https://example.com/video.mp4',
    ]) {
      const { provider, requests } = mockProvider();
      await provider.postPending(
        'user-id',
        'access-token',
        [
          {
            id: 'post1',
            message: 'Hello',
            settings: { topic_tag: 'Tech News' },
            media: [{ path }],
          },
        ] as any,
        {} as Integration
      );

      expect(new URL(requests[0].url).searchParams.get('topic_tag')).toBe(
        'Tech News'
      );
    }
  });

  it('sets topic tag only on the parent carousel container', async () => {
    const { provider, requests } = mockProvider();
    const [pending] = await provider.postPending(
      'user-id',
      'access-token',
      [
        {
          id: 'post1',
          message: 'Carousel',
          settings: { topic_tag: 'Digital Marketing' },
          media: [
            { path: 'https://example.com/a.jpg' },
            { path: 'https://example.com/b.jpg' },
          ],
        },
      ] as any,
      {} as Integration
    );

    expect(requests).toHaveLength(2);
    expect(
      requests.every((request) => !new URL(request.url).searchParams.has('topic_tag'))
    ).toBe(true);
    expect((pending.pendingData as any).topicTag).toBe('Digital Marketing');

    await provider.finalizePost(
      'access-token',
      pending.pendingData as any,
      { internalId: 'user-id' } as Integration
    );

    const parentParams = new URL(requests[2].url).searchParams;
    expect(parentParams.get('media_type')).toBe('CAROUSEL');
    expect(parentParams.get('topic_tag')).toBe('Digital Marketing');
  });

  it('does not change text containers without a topic', async () => {
    const { provider, requests } = mockProvider();
    await provider.postPending(
      'user-id',
      'access-token',
      [{ id: 'post1', message: 'Hello', settings: {}, media: [] }] as any,
      {} as Integration
    );

    expect((requests[0].options?.body as FormData).has('topic_tag')).toBe(false);
  });
});
