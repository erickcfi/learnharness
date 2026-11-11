-- North Aero Ground Tutor: a topic_labels row for a chat the tenant server
-- does not have (master decision, 2026-11-10).
--
-- The non-aviation sweep (frontdoor/admin/flags.ts) asks each student's
-- tutor server for an ended session's title and plan topics. When the chat
-- is gone (deleted, or never saved), the server answers 404. Before this,
-- nothing was stored, so the sweep asked again every 5 minutes, forever, and
-- 50 such chats would have filled every sweep and stopped labeling for all
-- students. Seen on staging on 2026-11-10.
--
-- Now the sweep stores a row with is_aviation null (no label) and model
-- 'none: chat not found'. The chat is checked again only if it is studied
-- again (labeled_at is older than its last study time). Null rows count
-- neither as aviation nor as not aviation on the dashboard.
--
-- Safe to run twice: dropping NOT NULL from a nullable column does nothing.

alter table public.topic_labels alter column is_aviation drop not null;

comment on column public.topic_labels.is_aviation is 'Haiku''s label: true aviation, false not aviation. Null: the tenant server had no such chat, so no label (model ''none: chat not found'').';
