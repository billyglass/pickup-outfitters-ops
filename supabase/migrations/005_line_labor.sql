-- 005_line_labor.sql — run once in the live Supabase SQL Editor.
--
-- Per-line Labor $ (Nov 18, 2026): Bill doesn't use Discount, the Product
-- picker, or Kind on ticket lines. Each line now has an optional flat
-- Labor $ amount, summed into the Labor total. New math, matching his
-- Excel template: Subtotal = parts only (qty x unit price), Tax = 7.74%
-- on taxable PARTS only (labor is not taxed), Total = Subtotal + Tax +
-- Labor. The old discount / product_id / line_kind columns are left in
-- place, unused — no data is dropped, no old ticket is rewritten.
alter table public.quote_lines add column if not exists labor_amount numeric(12,2) not null default 0;
alter table public.invoice_lines add column if not exists labor_amount numeric(12,2) not null default 0;
