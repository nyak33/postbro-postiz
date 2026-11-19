import { FC } from 'react';

/**
 * A Threads-style topic indicator, shown beside the author/handle.
 * This is visual metadata only; it is not appended to the published post text.
 */
export const ThreadsTopicTagPreview: FC<{ topicTag?: string }> = ({ topicTag }) => {
  const label = topicTag?.trim();
  if (!label) return null;

  return (
    <span
      data-testid="threads-topic-tag-preview"
      aria-label={`Threads topic: ${label}`}
      title={`Topic: ${label}`}
      className="inline-flex min-w-0 max-w-full items-center gap-[6px] text-[13px] font-[600] text-[#0095f6]"
    >
      <span
        aria-hidden="true"
        className="inline-block h-[7px] w-[7px] shrink-0 rotate-45 rounded-[1px] bg-[#0095f6]"
      />
      <span className="truncate">{label}</span>
    </span>
  );
};
