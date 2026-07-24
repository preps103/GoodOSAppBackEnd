BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  vin text NOT NULL,
  license_plate text NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  model_year integer NOT NULL CHECK (model_year BETWEEN 1900 AND 2200),
  status text NOT NULL DEFAULT 'available',
  assigned_branch_id text,
  daily_rate numeric(12,2) NOT NULL CHECK (daily_rate >= 0),
  registration_expiry date,
  insurance_expiry date,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, vin),
  UNIQUE (organization_id, license_plate),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_vehicles_org_status_idx
  ON fleet_vehicles (organization_id, status);

CREATE TABLE IF NOT EXISTS fleet_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text,
  status text NOT NULL DEFAULT 'active',
  license_number text NOT NULL,
  license_expiry date NOT NULL,
  license_verification_status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email),
  UNIQUE (organization_id, license_number),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_customers_org_status_idx
  ON fleet_customers (organization_id, status);

CREATE TABLE IF NOT EXISTS fleet_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  reservation_number text NOT NULL,
  customer_id uuid NOT NULL,
  vehicle_id uuid,
  pickup_at timestamptz NOT NULL,
  return_at timestamptz NOT NULL,
  pickup_branch_id text NOT NULL,
  return_branch_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending_payment',
  payment_status text NOT NULL DEFAULT 'unpaid',
  total_amount numeric(12,2) NOT NULL CHECK (total_amount >= 0),
  deposit_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  paid_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (return_at > pickup_at),
  UNIQUE (organization_id, reservation_number),
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id)
);

ALTER TABLE fleet_bookings
  DROP CONSTRAINT IF EXISTS fleet_bookings_no_vehicle_overlap;

ALTER TABLE fleet_bookings
  ADD CONSTRAINT fleet_bookings_no_vehicle_overlap
  EXCLUDE USING gist (
    organization_id WITH =,
    vehicle_id WITH =,
    tstzrange(pickup_at - interval '2 hours', return_at + interval '2 hours', '[)') WITH &&
  )
  WHERE (
    vehicle_id IS NOT NULL AND status IN (
      'pending_payment', 'confirmed', 'assigned', 'checked_in',
      'checked_out', 'extended', 'overdue'
    )
  );

CREATE INDEX IF NOT EXISTS fleet_bookings_org_dates_idx
  ON fleet_bookings (organization_id, pickup_at, return_at);
CREATE INDEX IF NOT EXISTS fleet_bookings_customer_idx
  ON fleet_bookings (organization_id, customer_id);

CREATE TABLE IF NOT EXISTS fleet_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_json jsonb,
  after_json jsonb,
  request_id text,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_audit_events_org_created_idx
  ON fleet_audit_events (organization_id, created_at DESC);

COMMIT;
