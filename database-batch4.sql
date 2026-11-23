-- Lost & Found: Batch 4 (edit, delete, and photos in messages).
-- Run once in phpMyAdmin (SQL tab or Import), AFTER database-batch3.sql. Existing messages are kept.

ALTER TABLE lf_messages
  ADD COLUMN photo      MEDIUMTEXT NULL AFTER body,      -- a photo sent in the chat (resized, as a data URL)
  ADD COLUMN edited_at  DATETIME   NULL AFTER read_at,
  ADD COLUMN deleted_at DATETIME   NULL AFTER edited_at,
  ADD COLUMN changed_at DATETIME   NULL AFTER deleted_at, -- last edit/delete, so open chats can update
  ADD KEY ix_changed (conv, changed_at);
