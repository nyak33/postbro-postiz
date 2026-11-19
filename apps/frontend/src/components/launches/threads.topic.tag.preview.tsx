import { FC } from 'react';

/** Shows the Threads topic as metadata; it is not part of the post body. */
export const ThreadsTopicTagPreview: FC<{ topicTag?: string }> = ({ topicTag }) => {
  const label = topicTag?.trim();
  if (!label) return null;

  return (
    <div
      data-testid="threads-topic-tag-preview"
      className="mt-[8px] flex items-center gap-[6px] text-[13px] text-customColor27"
    >
      <span>Topic:</span>
      <span className="font-[600] text-customColor26">{label}</span>
    </div>
  );
};
