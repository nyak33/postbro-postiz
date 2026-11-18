import { IsBoolean, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

export class ThreadsDto {
  @ValidateIf((_, value) => value !== undefined && value !== null && value !== '')
  @IsString()
  @Length(1, 50)
  @Matches(/^(?!\s)(?!.*\s$)[^.#&\r\n]+$/, {
    message: 'Topic Tag cannot include #, . or &, or start/end with whitespace',
  })
  @JSONSchema({
    description:
      'Optional Threads Topic Tag (one per post, 1-50 characters). Do not include #, periods, or ampersands.',
  })
  topic_tag?: string;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({
    description:
      'Labels the post as AI generated (Threads shows the "AI info" label). Works for text, image, video and carousel posts.',
  })
  made_with_ai?: boolean;
}
