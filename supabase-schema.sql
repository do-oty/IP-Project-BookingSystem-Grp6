-- ========================================================
-- K-SOUNDRENTALS — Supabase Cloud Database Schema
-- Run this script in your Supabase SQL Editor
-- ========================================================

-- 1. Create Bookings Table
create table if not exists public.bookings (
  id text primary key,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  name text not null,
  phone text not null,
  fb_name text,
  date text not null,
  delivery_time text not null,
  package text not null,
  address text not null,
  map_link text,
  payment_channel text,
  payment_type text,
  amount_due numeric,
  reference_no text,
  proof_url text,
  status text default 'pending_deposit' -- 'pending_deposit' | 'deposit_verified' | 'dispatched' | 'completed' | 'cancelled'
);

alter table public.bookings add column if not exists proof_url text;

-- Prevent concurrent double-bookings on the same active date
create unique index if not exists idx_bookings_active_date
  on public.bookings (date)
  where status <> 'cancelled';

-- 2. Create Blocked Dates Table (Calendar Availability Sync)
create table if not exists public.blocked_dates (
  date text primary key,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 3. Row-Level Security (RLS)
alter table public.bookings enable row level security;
alter table public.blocked_dates enable row level security;

-- Bookings: public can only insert new pending reservations; only authenticated admins can read/update/delete
drop policy if exists "Allow public read bookings" on public.bookings;
drop policy if exists "Allow public insert bookings" on public.bookings;
drop policy if exists "Allow public update bookings" on public.bookings;
drop policy if exists "Allow public delete bookings" on public.bookings;
drop policy if exists "Allow anon insert bookings" on public.bookings;

create policy "Allow anon insert pending bookings"
  on public.bookings for insert
  to anon, authenticated
  with check (status = 'pending_deposit');

create policy "Allow authenticated select bookings"
  on public.bookings for select
  to authenticated
  using (true);

create policy "Allow authenticated update bookings"
  on public.bookings for update
  to authenticated
  using (true);

create policy "Allow authenticated delete bookings"
  on public.bookings for delete
  to authenticated
  using (true);

-- Blocked dates: public can read availability; only authenticated admins (or create_booking RPC) can modify
drop policy if exists "Allow public read blocked_dates" on public.blocked_dates;
drop policy if exists "Allow public insert blocked_dates" on public.blocked_dates;
drop policy if exists "Allow public delete blocked_dates" on public.blocked_dates;
drop policy if exists "Allow anon insert blocked_dates" on public.blocked_dates;

create policy "Allow public read blocked_dates"
  on public.blocked_dates for select
  to anon, authenticated
  using (true);

create policy "Allow authenticated insert blocked_dates"
  on public.blocked_dates for insert
  to authenticated
  with check (true);

create policy "Allow authenticated update blocked_dates"
  on public.blocked_dates for update
  to authenticated
  using (true);

create policy "Allow authenticated delete blocked_dates"
  on public.blocked_dates for delete
  to authenticated
  using (true);

-- 4. Atomic Booking + Date-Lock RPC
create or replace function public.create_booking(
  p_id text,
  p_name text,
  p_phone text,
  p_fb_name text,
  p_date text,
  p_delivery_time text,
  p_package text,
  p_address text,
  p_map_link text,
  p_payment_channel text,
  p_payment_type text,
  p_amount_due numeric,
  p_reference_no text,
  p_proof_url text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  perform pg_advisory_xact_lock(hashtext(coalesce(p_date, '')));

  if exists (select 1 from public.blocked_dates where date = p_date)
     or exists (select 1 from public.bookings where date = p_date and status <> 'cancelled') then
    raise exception 'DATE_ALREADY_BOOKED' using errcode = 'P0001';
  end if;

  insert into public.bookings (
    id, name, phone, fb_name, date, delivery_time,
    package, address, map_link, payment_channel,
    payment_type, amount_due, reference_no, proof_url, status
  ) values (
    p_id, p_name, p_phone, nullif(p_fb_name, ''), p_date, p_delivery_time,
    p_package, p_address, nullif(p_map_link, ''), p_payment_channel,
    p_payment_type, p_amount_due, nullif(p_reference_no, ''), nullif(p_proof_url, ''), 'pending_deposit'
  )
  returning * into v_booking;

  insert into public.blocked_dates (date)
  values (p_date)
  on conflict (date) do nothing;

  return v_booking;
end;
$$;

revoke all on function public.create_booking(text, text, text, text, text, text, text, text, text, text, text, numeric, text, text) from public;
grant execute on function public.create_booking(text, text, text, text, text, text, text, text, text, text, text, numeric, text, text) to anon, authenticated;

-- 5. Storage Bucket for GCash Payment Proofs
insert into storage.buckets (id, name, public)
values ('payment-proofs', 'payment-proofs', true)
on conflict (id) do nothing;

drop policy if exists "Allow public upload payment-proofs" on storage.objects;
drop policy if exists "Allow public read payment-proofs" on storage.objects;

create policy "Allow public upload payment-proofs"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'payment-proofs');

create policy "Allow public read payment-proofs"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'payment-proofs');
