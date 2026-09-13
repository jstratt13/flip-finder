-- 0002 — make sessions revocable.
--
-- JWTs are stateless, so a valid signature was previously enough to be let in.
-- That meant neither changing a password nor deactivating a contributor could
-- end a session already in progress — the old token stayed good until it
-- expired. Tokens now carry the version they were issued under, and anything
-- that should end a session bumps it.

ALTER TABLE contributors ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
