-- Least-privilege setup for the addon's runtime role. Idempotent; run as the
-- superuser against the production DB:
--   docker exec -i omnicatalogs-db psql -U omnicatalogs -d omnicatalogs -v ON_ERROR_STOP=1 \
--     < docker/postgres/harden-roles.sql
--
-- The app role (omnicatalogs_app) may only read/write the rows of the two
-- tables the addon uses. It owns nothing, cannot create objects, and cannot
-- TRUNCATE/ALTER/DROP anything. Schema changes are made by the superuser:
-- the app's ensureSchema() skips DDL when the schema is already current.
BEGIN;

-- Tables are owned by the admin, not the app (an owner can DROP/ALTER/TRUNCATE
-- and grant itself anything back).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT format('%I.%I', schemaname, tablename) AS name
             FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO omnicatalogs', t.name);
  END LOOP;
  FOR t IN SELECT format('%I.%I', schemaname, sequencename) AS name
             FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO omnicatalogs', t.name);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM omnicatalogs_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM omnicatalogs_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC, omnicatalogs_app;
GRANT USAGE ON SCHEMA public TO omnicatalogs_app;

-- Only what the code runs (warmCache.js: query_cache, visitors.js: hourly_visitors).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.query_cache, public.hourly_visitors
  TO omnicatalogs_app;

-- Nobody else may connect or create temp tables in this DB.
REVOKE ALL ON DATABASE omnicatalogs FROM PUBLIC, omnicatalogs_app;
GRANT CONNECT ON DATABASE omnicatalogs TO omnicatalogs_app;

ALTER ROLE omnicatalogs_app
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 30;
-- A leaked or runaway session can't hold locks or a connection forever.
ALTER ROLE omnicatalogs_app SET statement_timeout = '120s';
ALTER ROLE omnicatalogs_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE omnicatalogs_app SET lock_timeout = '15s';

COMMIT;
