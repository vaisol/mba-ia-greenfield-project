import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UploadPartDto {
  @IsNumber()
  PartNumber: number;

  @IsString()
  ETag: string;
}

export class CompleteUploadDto {
  @IsUUID()
  @IsNotEmpty()
  videoId: string;

  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
