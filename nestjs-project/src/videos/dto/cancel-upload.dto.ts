import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CancelUploadDto {
  @IsUUID()
  @IsNotEmpty()
  videoId: string;

  @IsString()
  @IsNotEmpty()
  uploadId: string;
}
