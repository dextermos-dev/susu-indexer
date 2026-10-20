-- Bulk update group states during reconciliation in O(1) round trips.
--
-- Previously, `upsertGroupState` updated groups one by one in a loop,
-- issuing N separate HTTP requests. This function updates all specified
-- groups in a single statement using `UPDATE ... FROM jsonb_to_recordset(...)`
-- and returns the contract_ids of all updated rows, preserving exact 39-digit
-- numeric precision and loud failures when a non-existent group is requested.

create or replace function public.bulk_update_group_state(p_states jsonb)
returns table (contract_id text)
language sql
as $$
  update public.groups g
  set
    status = s.status,
    member_count = s.member_count,
    current_round = s.current_round,
    completed_rounds = s.completed_rounds,
    contributed_total = s.contributed_total::numeric,
    paid_out_total = s.paid_out_total::numeric,
    fee_total = s.fee_total::numeric,
    last_event_ledger = s.last_event_ledger,
    updated_at = coalesce(s.updated_at, now())
  from jsonb_to_recordset(p_states) as s(
    contract_id text,
    status text,
    member_count integer,
    current_round integer,
    completed_rounds integer,
    contributed_total text,
    paid_out_total text,
    fee_total text,
    last_event_ledger bigint,
    updated_at timestamptz
  )
  where g.contract_id = s.contract_id
  returning g.contract_id;
$$;

comment on function public.bulk_update_group_state(jsonb) is
  'Bulk update group states during reconciliation in a single round trip.';

grant execute on function public.bulk_update_group_state(jsonb) to service_role;
