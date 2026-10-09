ALTER TABLE `branch_relations` ADD COLUMN `continuation_message_id` text
  CONSTRAINT "continuation_nonempty" CHECK (`continuation_message_id` IS NULL OR length(`continuation_message_id`) > 0);
--> statement-breakpoint
PRAGMA user_version = 2;
