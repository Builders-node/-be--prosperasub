-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260528233146 · create_all_business_tables


-- ============================================================
-- CLEANING PACKAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_packages (
  id                      text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                    text        NOT NULL,
  description             text,
  price_per_cleaning_cents integer    NOT NULL DEFAULT 0,
  cleanings_per_month     integer     NOT NULL DEFAULT 4,
  is_active               boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cp_active ON public.cleaning_packages(is_active);

-- ============================================================
-- CLEANING AVAILABLE SLOTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_available_slots (
  id               text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date             date        NOT NULL,
  start_time       text        NOT NULL,
  end_time         text        NOT NULL,
  max_bookings     integer     NOT NULL DEFAULT 1,
  current_bookings integer     NOT NULL DEFAULT 0,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_bookings_non_negative CHECK (current_bookings >= 0),
  UNIQUE (date, start_time, end_time)
);
CREATE INDEX IF NOT EXISTS idx_cas_date_active ON public.cleaning_available_slots(date, is_active);

-- ============================================================
-- CLEANING CLIENTS (B2B corporate clients)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_clients (
  id                   text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_name         text        NOT NULL,
  contact_person       text,
  email                text,
  phone                text,
  location             text        NOT NULL DEFAULT '',
  service_type         text,
  notes                text,
  internal_admin_notes text,
  invoice_preferences  text,
  start_date           date,
  status               text        NOT NULL DEFAULT 'active',
  is_private           boolean     NOT NULL DEFAULT true,
  visibility           text        NOT NULL DEFAULT 'admin_only',
  client_type          text        NOT NULL DEFAULT 'custom_cleaning_client',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cc_status ON public.cleaning_clients(status);

-- ============================================================
-- CLEANING CUSTOM PLANS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_custom_plans (
  id                           text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_id                    text        NOT NULL REFERENCES public.cleaning_clients(id) ON DELETE CASCADE,
  plan_name                    text        NOT NULL,
  custom_price_cents           integer     NOT NULL DEFAULT 0,
  billing_type                 text        NOT NULL DEFAULT 'custom',
  monthly_invoice              boolean     NOT NULL DEFAULT false,
  payment_timing               text        NOT NULL DEFAULT 'custom_terms',
  custom_terms                 text,
  service_frequency            text,
  days_of_week                 text[]      NOT NULL DEFAULT '{}',
  deep_cleaning_add_on         boolean     NOT NULL DEFAULT false,
  estimated_monthly_total_cents integer,
  custom_checklist             text[]      NOT NULL DEFAULT '{}',
  status                       text        NOT NULL DEFAULT 'active',
  is_private                   boolean     NOT NULL DEFAULT true,
  visibility                   text        NOT NULL DEFAULT 'admin_only',
  client_type                  text        NOT NULL DEFAULT 'custom_cleaning_client',
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ccp_client_status ON public.cleaning_custom_plans(client_id, status);

-- ============================================================
-- CLEANING RECURRING SCHEDULES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_recurring_schedules (
  id                       text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_id                text        NOT NULL REFERENCES public.cleaning_clients(id) ON DELETE CASCADE,
  custom_plan_id           text        NOT NULL REFERENCES public.cleaning_custom_plans(id) ON DELETE CASCADE,
  start_date               date        NOT NULL,
  end_date                 date,
  days_of_week             text[]      NOT NULL DEFAULT '{}',
  preferred_start_time     text        NOT NULL DEFAULT '',
  preferred_end_time       text        NOT NULL DEFAULT '',
  assigned_cleaner         text,
  location                 text        NOT NULL DEFAULT '',
  service_duration_minutes integer     NOT NULL DEFAULT 120,
  repeat_frequency         text        NOT NULL DEFAULT 'weekly',
  status                   text        NOT NULL DEFAULT 'active',
  paused_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crs_client_status ON public.cleaning_recurring_schedules(client_id, status);
CREATE INDEX IF NOT EXISTS idx_crs_plan_status ON public.cleaning_recurring_schedules(custom_plan_id, status);

-- ============================================================
-- CLEANING CHECKLIST TEMPLATES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_checklist_templates (
  id             text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_id      text        NOT NULL REFERENCES public.cleaning_clients(id) ON DELETE CASCADE,
  custom_plan_id text        NOT NULL REFERENCES public.cleaning_custom_plans(id) ON DELETE CASCADE,
  template_type  text        NOT NULL DEFAULT 'custom',
  name           text        NOT NULL,
  items          text[]      NOT NULL DEFAULT '{}',
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cct_plan_active ON public.cleaning_checklist_templates(custom_plan_id, is_active);

-- ============================================================
-- CLEANING SUBSCRIPTIONS (B2C user packages)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_subscriptions (
  id                    text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id               text        NOT NULL,
  package_id            text        NOT NULL,
  start_date            date,
  end_date              date,
  service_start_date    date,
  service_end_date      date,
  paid_until            date,
  billing_period_months integer     NOT NULL DEFAULT 1,
  monthly_price_cents   integer     NOT NULL DEFAULT 0,
  total_price_cents     integer     NOT NULL DEFAULT 0,
  cleanings_remaining   integer     NOT NULL DEFAULT 0,
  payment_status        text        NOT NULL DEFAULT 'pending',
  subscription_status   text        NOT NULL DEFAULT 'pending',
  payment_method        text,
  payment_reference     text,
  recurring_day_of_week integer,
  recurring_time        text,
  apartment_note        text,
  is_active             boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_csub_user_active ON public.cleaning_subscriptions(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_csub_status ON public.cleaning_subscriptions(subscription_status, payment_status);

-- ============================================================
-- CLEANING BOOKINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_bookings (
  id                         text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                    text        NOT NULL,
  slot_id                    text        NOT NULL REFERENCES public.cleaning_available_slots(id) ON DELETE RESTRICT,
  cleaning_subscription_id   text        REFERENCES public.cleaning_subscriptions(id) ON DELETE SET NULL,
  subscription_id            text,
  client_id                  text        REFERENCES public.cleaning_clients(id) ON DELETE SET NULL,
  custom_plan_id             text        REFERENCES public.cleaning_custom_plans(id) ON DELETE SET NULL,
  recurring_schedule_id      text        REFERENCES public.cleaning_recurring_schedules(id) ON DELETE SET NULL,
  checklist_template_id      text        REFERENCES public.cleaning_checklist_templates(id) ON DELETE SET NULL,
  status                     text        NOT NULL DEFAULT 'booked',
  notes                      text,
  location                   text,
  assigned_cleaner           text,
  service_duration_minutes   integer,
  source                     text,
  is_private                 boolean     NOT NULL DEFAULT false,
  visibility                 text,
  client_type                text,
  google_calendar_event_id   text,
  google_calendar_event_link text,
  google_calendar_synced_at  timestamptz,
  google_calendar_sync_status text       NOT NULL DEFAULT 'pending',
  google_calendar_sync_error  text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cb_user_status ON public.cleaning_bookings(user_id, status);
CREATE INDEX IF NOT EXISTS idx_cb_client_status ON public.cleaning_bookings(client_id, status);
CREATE INDEX IF NOT EXISTS idx_cb_slot ON public.cleaning_bookings(slot_id);
CREATE INDEX IF NOT EXISTS idx_cb_calendar_status ON public.cleaning_bookings(google_calendar_sync_status);

-- ============================================================
-- CLEANING COMPLETION REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleaning_completion_reports (
  id                  text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  booking_id          text        NOT NULL UNIQUE REFERENCES public.cleaning_bookings(id) ON DELETE CASCADE,
  client_id           text,
  custom_plan_id      text,
  checklist_completed text[]      NOT NULL DEFAULT '{}',
  notes               text,
  photo_url           text,
  issue_report        text,
  completed_by        text        NOT NULL DEFAULT '',
  completed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ccr_client ON public.cleaning_completion_reports(client_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_ccr_plan ON public.cleaning_completion_reports(custom_plan_id, completed_at);

-- ============================================================
-- FAVORITES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.favorites (
  id            text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       text        NOT NULL,
  restaurant_id text,
  plan_id       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fav_user ON public.favorites(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fav_user_restaurant ON public.favorites(user_id, restaurant_id) WHERE restaurant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fav_user_plan ON public.favorites(user_id, plan_id) WHERE plan_id IS NOT NULL;

-- ============================================================
-- USER PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id                       text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                  text        NOT NULL UNIQUE,
  phone_number             text,
  telegram_username        text,
  default_delivery_address text,
  nwc_connection           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- GLOBAL SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.global_settings (
  id         text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  key        text        NOT NULL UNIQUE,
  value      jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.global_settings (key, value)
VALUES
  ('cutoff_hour', '18'::jsonb),
  ('delivery_fee_cents', '0'::jsonb),
  ('booking_window_days', '110'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- FOOD SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           text        NOT NULL,
  restaurant_id     text,
  plan_id           text,
  start_date        date        NOT NULL,
  end_date          date        NOT NULL,
  duration_weeks    integer     NOT NULL DEFAULT 1,
  total_price_cents integer     NOT NULL DEFAULT 0,
  paid_amount_sats  integer,
  payment_status    text        NOT NULL DEFAULT 'pending',
  payment_method    text,
  payment_reference text,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_user_active ON public.subscriptions(user_id, is_active);

-- ============================================================
-- DAILY MEAL CHOICES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.daily_meal_choices (
  id              text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  subscription_id text        NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  date            date        NOT NULL,
  choice          text        NOT NULL DEFAULT 'eat_in',
  status          text        NOT NULL DEFAULT 'pending',
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, date)
);
CREATE INDEX IF NOT EXISTS idx_dmc_date_status ON public.daily_meal_choices(date, status);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.payments (
  id              text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         text        NOT NULL,
  restaurant_id   text,
  subscription_id text,
  amount_cents    integer,
  amount_sats     integer,
  currency        text        NOT NULL DEFAULT 'USD',
  method          text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  provider        text,
  provider_ref    text,
  description     text,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_user_status ON public.payments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_pay_provider_ref ON public.payments(provider_ref);

-- ============================================================
-- PAYMENT CHECKOUT SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.payment_checkout_sessions (
  id                  text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider            text        NOT NULL,
  provider_payment_id text        NOT NULL,
  context             text,
  service_name        text        NOT NULL DEFAULT '',
  client_name         text,
  client_email        text,
  client_phone        text,
  amount_cents        integer,
  amount_sats         integer,
  currency            text        NOT NULL DEFAULT 'USD',
  plan_name           text,
  duration            text,
  booking_id          text,
  admin_url           text,
  selected_date_time  text,
  description         text,
  external_id         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_pcs_context ON public.payment_checkout_sessions(context);

-- ============================================================
-- ADMIN PAYMENT NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_payment_notifications (
  id                  text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider            text        NOT NULL,
  provider_payment_id text        NOT NULL,
  service_name        text        NOT NULL DEFAULT '',
  client_name         text,
  client_email        text,
  client_phone        text,
  amount_cents        integer,
  amount_sats         integer,
  currency            text        NOT NULL DEFAULT 'USD',
  plan_name           text,
  duration            text,
  booking_id          text,
  admin_url           text,
  selected_date_time  text,
  payment_status      text        NOT NULL DEFAULT 'paid',
  paid_at             timestamptz NOT NULL DEFAULT now(),
  email_status        text        NOT NULL DEFAULT 'pending',
  email_sent_at       timestamptz,
  email_error         text,
  telegram_status     text        NOT NULL DEFAULT 'pending',
  telegram_sent_at    timestamptz,
  telegram_error      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_apn_paid_at ON public.admin_payment_notifications(paid_at);
CREATE INDEX IF NOT EXISTS idx_apn_status ON public.admin_payment_notifications(email_status, telegram_status);

-- ============================================================
-- RESTAURANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.restaurants (
  id            text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          text        NOT NULL,
  description   text,
  address       text,
  logo_url      text,
  opening_hours jsonb,
  is_active     boolean     NOT NULL DEFAULT true,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rest_active ON public.restaurants(is_active);

-- ============================================================
-- SUBSCRIPTION PLANS (food)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id                   text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  restaurant_id        text        REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name                 text        NOT NULL,
  description          text,
  price_per_week_cents integer     NOT NULL DEFAULT 0,
  meal_time            text        NOT NULL DEFAULT '13:00:00',
  menu_category        text        NOT NULL DEFAULT 'standard',
  supports_delivery    boolean     NOT NULL DEFAULT false,
  max_duration_weeks   integer     NOT NULL DEFAULT 1,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sp_restaurant_active ON public.subscription_plans(restaurant_id, is_active);

-- ============================================================
-- RESTAURANT SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.restaurant_settings (
  id                 text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  restaurant_id      text        NOT NULL UNIQUE REFERENCES public.restaurants(id) ON DELETE CASCADE,
  cutoff_hour        integer     NOT NULL DEFAULT 18,
  delivery_fee_cents integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- WEEKLY MENUS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.weekly_menus (
  id              text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  restaurant_id   text        NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  plan_id         text        REFERENCES public.subscription_plans(id) ON DELETE SET NULL,
  week_start_date date        NOT NULL,
  week_end_date   date        NOT NULL,
  category        text        NOT NULL DEFAULT 'standard',
  status          text        NOT NULL DEFAULT 'draft',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, week_start_date, category)
);
CREATE INDEX IF NOT EXISTS idx_wm_restaurant_status ON public.weekly_menus(restaurant_id, status);

-- ============================================================
-- MENU ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.menu_items (
  id             text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  weekly_menu_id text        NOT NULL REFERENCES public.weekly_menus(id) ON DELETE CASCADE,
  restaurant_id  text        NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  day_of_week    text        NOT NULL,
  meal_type      text        NOT NULL,
  name           text        NOT NULL,
  description    text,
  tags           text[]      NOT NULL DEFAULT '{}',
  image_url      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mi_restaurant_day ON public.menu_items(restaurant_id, day_of_week, meal_type);

-- ============================================================
-- LOGIN HISTORY (no FK to users — user_id stored as text)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.login_history (
  id         text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    text        NOT NULL,
  provider   text        NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lh_user ON public.login_history(user_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE public.cleaning_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_available_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_custom_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_recurring_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_completion_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_meal_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_payment_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_history ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS POLICIES
-- ============================================================
CREATE POLICY "open_cleaning_packages"            ON public.cleaning_packages            FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_cleaning_slots"               ON public.cleaning_available_slots      FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_cleaning_clients"             ON public.cleaning_clients              FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_cleaning_custom_plans"        ON public.cleaning_custom_plans         FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_cleaning_recurring_schedules" ON public.cleaning_recurring_schedules  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_cleaning_checklist_templates" ON public.cleaning_checklist_templates  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_cleaning_subscriptions"       ON public.cleaning_subscriptions        FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_cleaning_bookings"            ON public.cleaning_bookings             FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_cleaning_completion_reports"  ON public.cleaning_completion_reports   FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_favorites"                    ON public.favorites                     FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_user_profiles"                ON public.user_profiles                 FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "read_global_settings"              ON public.global_settings               FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "open_subscriptions"                ON public.subscriptions                 FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_daily_meal_choices"           ON public.daily_meal_choices            FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_payments"                     ON public.payments                      FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_pcs"                          ON public.payment_checkout_sessions     FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_apn"                          ON public.admin_payment_notifications   FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_restaurants"                  ON public.restaurants                   FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_subscription_plans"           ON public.subscription_plans            FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_restaurant_settings"          ON public.restaurant_settings           FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_weekly_menus"                 ON public.weekly_menus                  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_menu_items"                   ON public.menu_items                    FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_login_history"                ON public.login_history                 FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
