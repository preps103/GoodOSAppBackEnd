BEGIN;

CREATE TABLE IF NOT EXISTS public.goodescrow_transactions (
  id TEXT PRIMARY KEY,
  owner_id UUID NOT NULL DEFAULT goodos_auth.uid() REFERENCES public.users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodescrow_transactions_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT goodescrow_transactions_payload_size
    CHECK (octet_length(payload::text) <= 1048576)
);

CREATE INDEX IF NOT EXISTS idx_goodescrow_transactions_owner_created
  ON public.goodescrow_transactions (owner_id, created_at DESC);

ALTER TABLE public.goodescrow_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goodescrow_transactions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goodescrow_transactions_owner ON public.goodescrow_transactions;
CREATE POLICY goodescrow_transactions_owner
  ON public.goodescrow_transactions
  FOR ALL
  TO goodos_authenticated
  USING (
    owner_id = goodos_auth.uid()
    AND goodos_auth.check_session() IS NULL
  )
  WITH CHECK (
    owner_id = goodos_auth.uid()
    AND goodos_auth.check_session() IS NULL
  );

DROP POLICY IF EXISTS goodescrow_transactions_backend ON public.goodescrow_transactions;
CREATE POLICY goodescrow_transactions_backend
  ON public.goodescrow_transactions
  FOR ALL
  TO goodapp_backend_user
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE VIEW goodos_api.goodescrow_transactions
WITH (security_invoker = true, security_barrier = true)
AS
SELECT id, payload, owner_id, created_at, updated_at
FROM public.goodescrow_transactions;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.goodescrow_transactions TO goodos_authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON goodos_api.goodescrow_transactions TO goodos_authenticated;
REVOKE ALL ON goodos_api.goodescrow_transactions FROM goodos_anon;

INSERT INTO backend_data_plane_publications (
  id,
  api_schema,
  api_name,
  source_schema,
  source_name,
  columns_json,
  operations_json,
  status,
  published_at,
  created_at,
  updated_at
)
VALUES (
  'dppub_goodescrow_transactions',
  'goodos_api',
  'goodescrow_transactions',
  'public',
  'goodescrow_transactions',
  '["id","payload","owner_id","created_at","updated_at"]'::jsonb,
  '["SELECT","INSERT","UPDATE","DELETE"]'::jsonb,
  'active',
  NOW(),
  NOW(),
  NOW()
)
ON CONFLICT (api_schema, api_name)
DO UPDATE SET
  columns_json = EXCLUDED.columns_json,
  operations_json = EXCLUDED.operations_json,
  status = 'active',
  unpublished_at = NULL,
  updated_at = NOW();

NOTIFY pgrst, 'reload schema';

COMMIT;
