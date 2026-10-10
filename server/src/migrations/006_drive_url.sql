-- Schema version 6: the filed document's Drive web URL, for the PWA's
-- "Open in Drive" link. Plaintext like drive_node_uid: it is built from IDs
-- only. NULL for documents filed before this column existed, or when the SDK
-- couldn't build a URL.
ALTER TABLE documents ADD COLUMN drive_url TEXT;
