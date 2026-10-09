CREATE TABLE `shared_message_mappings` (
	`child_session_ref_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`parent_message_id` text NOT NULL,
	`child_message_id` text NOT NULL,
	PRIMARY KEY(`child_session_ref_id`, `ordinal`),
	FOREIGN KEY (`child_session_ref_id`) REFERENCES `branch_relations`(`child_session_ref_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mapping_ordinal" CHECK("shared_message_mappings"."ordinal" >= 0),
	CONSTRAINT "mapping_nonempty" CHECK(length("shared_message_mappings"."parent_message_id") > 0 AND length("shared_message_mappings"."child_message_id") > 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_message_mappings_child_session_ref_id_parent_message_id_unique` ON `shared_message_mappings` (`child_session_ref_id`,`parent_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shared_message_mappings_child_session_ref_id_child_message_id_unique` ON `shared_message_mappings` (`child_session_ref_id`,`child_message_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`project_id` text PRIMARY KEY NOT NULL,
	`current_path` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "project_path_absolute" CHECK(substr("projects"."current_path", 1, 1) = '/')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_current_path_unique` ON `projects` (`current_path`);--> statement-breakpoint
CREATE TABLE `branch_relations` (
	`child_session_ref_id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`parent_session_ref_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`scope_id`,`child_session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`,`parent_session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "distinct_parent" CHECK("branch_relations"."child_session_ref_id" <> "branch_relations"."parent_session_ref_id"),
	CONSTRAINT "source_nonempty" CHECK(length("branch_relations"."source_message_id") > 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `relation_parent` ON `branch_relations` (`scope_id`,`parent_session_ref_id`);--> statement-breakpoint
CREATE TABLE `removal_message_aliases` (
	`scope_id` text NOT NULL,
	`removal_id` text NOT NULL,
	`session_ref_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`removal_id`, `session_ref_id`, `message_id`),
	FOREIGN KEY (`scope_id`,`removal_id`) REFERENCES `removals`(`scope_id`,`removal_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_id`,`session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "removal_alias_nonempty" CHECK(length("removal_message_aliases"."message_id") > 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `removal_alias_session` ON `removal_message_aliases` (`scope_id`,`session_ref_id`);--> statement-breakpoint
CREATE TABLE `removal_members` (
	`scope_id` text NOT NULL,
	`removal_id` text NOT NULL,
	`session_ref_id` text NOT NULL,
	PRIMARY KEY(`removal_id`, `session_ref_id`),
	FOREIGN KEY (`scope_id`,`removal_id`) REFERENCES `removals`(`scope_id`,`removal_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_id`,`session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `removal_member_session` ON `removal_members` (`scope_id`,`session_ref_id`);--> statement-breakpoint
CREATE TABLE `removals` (
	`removal_id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`kind` text NOT NULL,
	`root_session_ref_id` text,
	`endpoint_session_ref_id` text,
	`after_message_id` text,
	`semantic_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `project_providers`(`scope_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`,`root_session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`,`endpoint_session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "removal_variant" CHECK(("removals"."kind" = 'tree' AND "removals"."root_session_ref_id" IS NOT NULL AND "removals"."endpoint_session_ref_id" IS NULL AND "removals"."after_message_id" IS NULL)
    OR ("removals"."kind" = 'message' AND "removals"."root_session_ref_id" IS NULL AND "removals"."endpoint_session_ref_id" IS NULL AND "removals"."after_message_id" IS NULL)
    OR ("removals"."kind" = 'endpoint' AND "removals"."root_session_ref_id" IS NULL AND "removals"."endpoint_session_ref_id" IS NOT NULL)),
	CONSTRAINT "removal_boundary" CHECK("removals"."after_message_id" IS NULL OR length("removals"."after_message_id") > 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `removals_scope_id_removal_id_unique` ON `removals` (`scope_id`,`removal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `removals_scope_id_semantic_key_unique` ON `removals` (`scope_id`,`semantic_key`);--> statement-breakpoint
CREATE TABLE `project_providers` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`legacy_import_digest` text,
	`legacy_imported_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "import_pair" CHECK(("project_providers"."legacy_import_digest" IS NULL) = ("project_providers"."legacy_imported_at" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `project_providers_project_id_provider_id_unique` ON `project_providers` (`project_id`,`provider_id`);--> statement-breakpoint
CREATE TABLE `session_refs` (
	`session_ref_id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`provider_session_id` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `project_providers`(`scope_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "session_nonempty" CHECK(length("session_refs"."provider_session_id") > 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `session_refs_scope_id_provider_session_id_unique` ON `session_refs` (`scope_id`,`provider_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_refs_scope_id_session_ref_id_unique` ON `session_refs` (`scope_id`,`session_ref_id`);--> statement-breakpoint
CREATE TABLE `workspace_message_aliases` (
	`scope_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`session_ref_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`scope_id`, `workspace_id`, `session_ref_id`, `message_id`),
	FOREIGN KEY (`scope_id`,`workspace_id`) REFERENCES `workspaces`(`scope_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_id`,`session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_alias_nonempty" CHECK(length("workspace_message_aliases"."message_id") > 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `workspace_alias_session` ON `workspace_message_aliases` (`scope_id`,`session_ref_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`scope_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`view` text NOT NULL,
	`selected_session_ref_id` text,
	`family_session_ref_id` text,
	`target_kind` text,
	`target_session_ref_id` text,
	`target_message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope_id`, `workspace_id`),
	FOREIGN KEY (`scope_id`) REFERENCES `project_providers`(`scope_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`,`selected_session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`,`family_session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`,`target_session_ref_id`) REFERENCES `session_refs`(`scope_id`,`session_ref_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_nonempty" CHECK(length("workspaces"."workspace_id") > 0),
	CONSTRAINT "workspace_variant" CHECK(("workspaces"."view" = 'roots' AND "workspaces"."family_session_ref_id" IS NULL AND "workspaces"."target_kind" IS NULL AND "workspaces"."target_session_ref_id" IS NULL AND "workspaces"."target_message_id" IS NULL)
    OR ("workspaces"."view" = 'terminal' AND "workspaces"."selected_session_ref_id" IS NULL AND "workspaces"."family_session_ref_id" IS NULL AND "workspaces"."target_kind" IS NULL AND "workspaces"."target_session_ref_id" IS NOT NULL AND "workspaces"."target_message_id" IS NULL)
    OR ("workspaces"."view" = 'graph' AND "workspaces"."selected_session_ref_id" IS NULL AND "workspaces"."family_session_ref_id" IS NOT NULL AND "workspaces"."target_session_ref_id" IS NOT NULL AND "workspaces"."target_kind" IS NOT NULL AND
      (("workspaces"."target_kind" = 'endpoint' AND "workspaces"."target_message_id" IS NULL) OR ("workspaces"."target_kind" = 'message' AND "workspaces"."target_message_id" IS NOT NULL AND length("workspaces"."target_message_id") > 0))))
) STRICT;
--> statement-breakpoint
PRAGMA application_id = 1129599557;
--> statement-breakpoint
PRAGMA user_version = 1;
