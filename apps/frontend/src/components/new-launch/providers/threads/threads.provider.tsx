'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { ThreadFinisher } from '@gitroom/frontend/components/new-launch/finisher/thread.finisher';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { ThreadsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/threads.dto';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { Input } from '@gitroom/react/form/input';
const SettingsComponent = () => {
  const t = useT();
  const { register } = useSettings();

  return (
    <>
      <div className="mb-5">
        <Input
          label={t('label_threads_topic_tag', 'Topic Tag (optional)')}
          placeholder={t('placeholder_threads_topic_tag', 'e.g. Digital Marketing')}
          {...register('topic_tag')}
        />
      </div>
      <div className="mb-5">
        <Checkbox
          label={t('label_made_with_ai', 'Made with AI')}
          {...register('made_with_ai')}
        />
      </div>

      <ThreadFinisher />
    </>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: SettingsComponent,
  CustomPreviewComponent: undefined,
  dto: ThreadsDto,
  maximumCharacters: 500,
});
