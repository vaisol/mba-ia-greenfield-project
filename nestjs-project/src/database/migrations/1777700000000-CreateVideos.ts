import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1777700000000 implements MigrationInterface {
  name = 'CreateVideos1777700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL, "description" text, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "slug" character varying(21) NOT NULL, "storage_key" character varying(512) NOT NULL, "thumbnail_storage_key" character varying(512), "duration" integer, "file_size" bigint, "mime_type" character varying(50), "original_filename" character varying(500), "processing_error" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_videos_slug" UNIQUE ("slug"), CONSTRAINT "PK_videos" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_status" ON "videos" ("channel_id", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channel" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_channel"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_videos_channel_status"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
