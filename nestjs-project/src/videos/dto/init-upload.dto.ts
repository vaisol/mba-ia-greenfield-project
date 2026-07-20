import { IsNumber, IsString, MaxLength, Min } from 'class-validator';

export class InitUploadDto {
  @IsString()
  @MaxLength(255)
  title: string;

  @IsString()
  @MaxLength(500)
  fileName: string;

  @IsNumber()
  @Min(1)
  fileSize: number;

  @IsString()
  @MaxLength(50)
  mimeType: string;
}
