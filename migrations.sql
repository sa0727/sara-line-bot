-- users: 課金状態の真実
create table if not exists users (
  line_user_id text primary key,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  current_period_end timestamptz,
  paid_until timestamptz,
  updated_at timestamptz not null default now()
);

-- payments: checkout発行のログ + 冪等に使える
create table if not exists payments (
  checkout_session_id text primary key,
  line_user_id text not null,
  stripe_subscription_id text,
  status text not null,
  created_at timestamptz not null default now()
);

-- processed_events: webhook二重処理防止
create table if not exists processed_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);
