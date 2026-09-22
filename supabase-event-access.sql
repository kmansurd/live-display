alter table public.submissions
  add column if not exists event_id text;

create index if not exists submissions_event_id_idx
  on public.submissions (event_id);
