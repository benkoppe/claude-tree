import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core"

const id = (name: string) => text(name).notNull()

export const projects = sqliteTable("projects", {
  id: id("project_id").primaryKey(), path: id("current_path").unique(),
  createdAt: id("created_at"), updatedAt: id("updated_at"),
}, (t) => [check("project_path_absolute", sql`substr(${t.path}, 1, 1) = '/'`)])

export const scopes = sqliteTable("project_providers", {
  id: id("scope_id").primaryKey(), projectId: id("project_id").references(() => projects.id),
  providerId: id("provider_id"), importDigest: text("legacy_import_digest"), importedAt: text("legacy_imported_at"),
}, (t) => [unique().on(t.projectId, t.providerId), check("import_pair", sql`(${t.importDigest} IS NULL) = (${t.importedAt} IS NULL)`)])

export const sessions = sqliteTable("session_refs", {
  id: id("session_ref_id").primaryKey(), scopeId: id("scope_id").references(() => scopes.id), providerSessionId: id("provider_session_id"),
}, (t) => [unique().on(t.scopeId, t.providerSessionId), unique().on(t.scopeId, t.id),
  check("session_nonempty", sql`length(${t.providerSessionId}) > 0`)])

export const relations = sqliteTable("branch_relations", {
  child: id("child_session_ref_id").primaryKey(), scopeId: id("scope_id"), parent: id("parent_session_ref_id"),
  source: id("source_message_id"), createdAt: id("created_at"),
}, (t) => [
  foreignKey({ columns: [t.scopeId, t.child], foreignColumns: [sessions.scopeId, sessions.id] }),
  foreignKey({ columns: [t.scopeId, t.parent], foreignColumns: [sessions.scopeId, sessions.id] }),
  check("distinct_parent", sql`${t.child} <> ${t.parent}`), check("source_nonempty", sql`length(${t.source}) > 0`),
  index("relation_parent").on(t.scopeId, t.parent),
])

export const mappings = sqliteTable("shared_message_mappings", {
  child: id("child_session_ref_id").references(() => relations.child, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(), parentMessage: id("parent_message_id"), childMessage: id("child_message_id"),
}, (t) => [primaryKey({ columns: [t.child, t.ordinal] }), unique().on(t.child, t.parentMessage), unique().on(t.child, t.childMessage),
  check("mapping_ordinal", sql`${t.ordinal} >= 0`), check("mapping_nonempty", sql`length(${t.parentMessage}) > 0 AND length(${t.childMessage}) > 0`)])

export const removals = sqliteTable("removals", {
  id: id("removal_id").primaryKey(), scopeId: id("scope_id").references(() => scopes.id),
  kind: id("kind"), root: text("root_session_ref_id"), endpoint: text("endpoint_session_ref_id"),
  afterMessage: text("after_message_id"), key: id("semantic_key"), createdAt: id("created_at"),
}, (t) => [unique().on(t.scopeId, t.id), unique().on(t.scopeId, t.key),
  foreignKey({ columns: [t.scopeId, t.root], foreignColumns: [sessions.scopeId, sessions.id] }),
  foreignKey({ columns: [t.scopeId, t.endpoint], foreignColumns: [sessions.scopeId, sessions.id] }),
  check("removal_variant", sql`(${t.kind} = 'tree' AND ${t.root} IS NOT NULL AND ${t.endpoint} IS NULL AND ${t.afterMessage} IS NULL)
    OR (${t.kind} = 'message' AND ${t.root} IS NULL AND ${t.endpoint} IS NULL AND ${t.afterMessage} IS NULL)
    OR (${t.kind} = 'endpoint' AND ${t.root} IS NULL AND ${t.endpoint} IS NOT NULL)`),
  check("removal_boundary", sql`${t.afterMessage} IS NULL OR length(${t.afterMessage}) > 0`),
])

export const removalMembers = sqliteTable("removal_members", {
  scopeId: id("scope_id"), removal: id("removal_id"), session: id("session_ref_id"),
}, (t) => [primaryKey({ columns: [t.removal, t.session] }),
  foreignKey({ columns: [t.scopeId, t.removal], foreignColumns: [removals.scopeId, removals.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.scopeId, t.session], foreignColumns: [sessions.scopeId, sessions.id] }),
  index("removal_member_session").on(t.scopeId, t.session)])

export const removalAliases = sqliteTable("removal_message_aliases", {
  scopeId: id("scope_id"), removal: id("removal_id"), session: id("session_ref_id"), message: id("message_id"),
}, (t) => [primaryKey({ columns: [t.removal, t.session, t.message] }),
  foreignKey({ columns: [t.scopeId, t.removal], foreignColumns: [removals.scopeId, removals.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.scopeId, t.session], foreignColumns: [sessions.scopeId, sessions.id] }),
  check("removal_alias_nonempty", sql`length(${t.message}) > 0`), index("removal_alias_session").on(t.scopeId, t.session)])

export const workspaces = sqliteTable("workspaces", {
  scopeId: id("scope_id").references(() => scopes.id), id: id("workspace_id"), view: id("view"),
  selected: text("selected_session_ref_id"), family: text("family_session_ref_id"), targetKind: text("target_kind"),
  target: text("target_session_ref_id"), message: text("target_message_id"), createdAt: id("created_at"), updatedAt: id("updated_at"),
}, (t) => [primaryKey({ columns: [t.scopeId, t.id] }),
  ...[t.selected, t.family, t.target].map((ref) => foreignKey({ columns: [t.scopeId, ref], foreignColumns: [sessions.scopeId, sessions.id] })),
  check("workspace_nonempty", sql`length(${t.id}) > 0`),
  check("workspace_variant", sql`(${t.view} = 'roots' AND ${t.family} IS NULL AND ${t.targetKind} IS NULL AND ${t.target} IS NULL AND ${t.message} IS NULL)
    OR (${t.view} = 'terminal' AND ${t.selected} IS NULL AND ${t.family} IS NULL AND ${t.targetKind} IS NULL AND ${t.target} IS NOT NULL AND ${t.message} IS NULL)
    OR (${t.view} = 'graph' AND ${t.selected} IS NULL AND ${t.family} IS NOT NULL AND ${t.target} IS NOT NULL AND ${t.targetKind} IS NOT NULL AND
      ((${t.targetKind} = 'endpoint' AND ${t.message} IS NULL) OR (${t.targetKind} = 'message' AND ${t.message} IS NOT NULL AND length(${t.message}) > 0)))`),
])

export const workspaceAliases = sqliteTable("workspace_message_aliases", {
  scopeId: id("scope_id"), workspace: id("workspace_id"), session: id("session_ref_id"), message: id("message_id"),
}, (t) => [primaryKey({ columns: [t.scopeId, t.workspace, t.session, t.message] }),
  foreignKey({ columns: [t.scopeId, t.workspace], foreignColumns: [workspaces.scopeId, workspaces.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.scopeId, t.session], foreignColumns: [sessions.scopeId, sessions.id] }),
  check("workspace_alias_nonempty", sql`length(${t.message}) > 0`), index("workspace_alias_session").on(t.scopeId, t.session)])
