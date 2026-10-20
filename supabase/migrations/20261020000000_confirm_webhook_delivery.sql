-- Susu Protocol — confirm webhook delivery before setting notified_at
--
-- WHY THIS EXISTS
-- Previously, `check_indexer_health` invoked `net.http_post` and immediately
-- updated `notified_at = v_now` in the same transaction. However, `pg_net`
-- queues HTTP requests and delivers them asynchronously after transaction commit.
-- If the webhook destination fails (e.g. 404, 500, timeout), the alert was
-- marked as delivered and never retried.
--
-- WHAT THIS CHANGES
-- 1. Adds `notify_request_id bigint` column to `public.indexer_alerts`.
-- 2. `check_indexer_health` stores the returned request_id from `net.http_post`.
-- 3. On each check run, it reconciles completed requests against `net._http_response`:
--    - Confirmed 2xx responses set `notified_at` once.
--    - Non-2xx/errored/timed-out responses clear `notify_request_id` so the alert
--      is retried on subsequent passes, guaranteeing at-least-once delivery semantics.
-- 4. Documentation clarifies at-least-once delivery guarantees.

-- ---------------------------------------------------------------------------
-- 1. Add notify_request_id column to indexer_alerts
-- ---------------------------------------------------------------------------
alter table public.indexer_alerts
  add column if not exists notify_request_id bigint;

comment on column public.indexer_alerts.notify_request_id is
  'pg_net request id for an in-flight webhook notification. Cleared upon response receipt; notified_at is set only after confirmed 2xx delivery.';

-- ---------------------------------------------------------------------------
-- 2. Update check_indexer_health with asynchronous webhook confirmation
-- ---------------------------------------------------------------------------
create or replace function public.check_indexer_health(
  stale_after interval default '30 minutes',
  failure_window interval default '1 hour',
  send_notifications boolean default true,
  lag_threshold_ledgers bigint default 60000
)
returns table (opened integer, resolved integer, open_now integer, notified integer)
language plpgsql
security definer
set search_path = public, extensions, vault
as $function$
declare
  v_now timestamptz := now();
  v_updated timestamptz;
  v_ledger bigint;
  v_last_seen bigint;
  v_before integer;
  v_after integer;
  v_resolved integer := 0;
  v_notified integer := 0;
  v_webhook text;
  v_alert record;
  v_request_id bigint;
begin
  -- The conditions that are true right now. A temp table rather than four
  -- repeated queries, because the same set is used to open alerts and then to
  -- decide which open alerts have cleared, and those two must agree exactly.
  drop table if exists pg_temp.indexer_conditions;
  create temp table indexer_conditions (kind text, subject text, detail jsonb) on commit drop;

  select c.updated_at, c.last_processed_ledger, c.last_seen_latest_ledger
    into v_updated, v_ledger, v_last_seen
  from public.indexer_checkpoints c
  where c.id = 'default';

  -- 1. A checkpoint that is stale, or that has never been written at all.
  if v_updated is null then
    insert into indexer_conditions (kind, subject, detail)
    values (
      'stale_checkpoint',
      'default',
      jsonb_build_object(
        'neverRan', true,
        'staleAfterSeconds', extract(epoch from stale_after)::bigint
      )
    );
  elsif v_updated < v_now - stale_after then
    insert into indexer_conditions (kind, subject, detail)
    values (
      'stale_checkpoint',
      'default',
      jsonb_build_object(
        'lastProcessedLedger', v_ledger,
        'checkpointUpdatedAt', v_updated,
        'secondsSinceCheckpoint', extract(epoch from (v_now - v_updated))::bigint,
        'staleAfterSeconds', extract(epoch from stale_after)::bigint
      )
    );
  end if;

  -- 2. Failures the indexer recorded within the failure window.
  insert into indexer_conditions (kind, subject, detail)
  select
    'failed_run',
    'default',
    jsonb_build_object(
      'failures', count(*),
      'newestReason', (array_agg(r.reason order by r.created_at desc))[1],
      'newestAt', max(r.created_at),
      'windowSeconds', extract(epoch from failure_window)::bigint
    )
  from public.indexer_runs r
  where r.status = 'failed'
    and r.created_at > v_now - failure_window
  having count(*) > 0;

  -- 3. Scheduled invocations that did not succeed.
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    insert into indexer_conditions (kind, subject, detail)
    select
      'failed_schedule',
      j.jobname,
      jsonb_build_object(
        'failures', count(*),
        'newestMessage', left((array_agg(coalesce(d.return_message, '') order by d.start_time desc))[1], 200),
        'newestAt', max(d.start_time),
        'windowSeconds', extract(epoch from failure_window)::bigint
      )
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
    where d.status <> 'succeeded'
      and d.start_time > v_now - failure_window
    group by j.jobname
    having count(*) > 0;
  end if;

  -- 4. The checkpoint is moving but the chain is outrunning it.
  if v_last_seen is not null and v_ledger is not null
    and (v_last_seen - v_ledger) > lag_threshold_ledgers then
    insert into indexer_conditions (kind, subject, detail)
    values (
      'ledger_lag',
      'default',
      jsonb_build_object(
        'lagLedgers', v_last_seen - v_ledger,
        'thresholdLedgers', lag_threshold_ledgers,
        'lastProcessedLedger', v_ledger,
        'lastSeenLatestLedger', v_last_seen
      )
    );
  end if;

  -- Open what is newly true, refresh what was already open.
  select count(*) into v_before from public.indexer_alerts where resolved_at is null;

  insert into public.indexer_alerts (kind, subject, detail)
  select kind, subject, detail from indexer_conditions
  on conflict (kind, subject) where resolved_at is null
  do update set detail = excluded.detail;

  select count(*) into v_after from public.indexer_alerts where resolved_at is null;

  -- Resolve what is no longer true.
  update public.indexer_alerts a
  set resolved_at = v_now
  where a.resolved_at is null
    and not exists (
      select 1 from indexer_conditions c
      where c.kind = a.kind and c.subject = a.subject
    );
  get diagnostics v_resolved = row_count;

  -- Reconcile webhook outcomes and notify pending alerts.
  -- At-least-once delivery: requests fire asynchronously via pg_net.
  -- Only confirmed 2xx HTTP responses mark an alert notified.
  if send_notifications then
    begin
      select s.decrypted_secret into v_webhook
      from vault.decrypted_secrets s
      where s.name = 'indexer_alert_webhook'
      limit 1;
    exception when others then
      v_webhook := null;
    end;

    if exists (select 1 from pg_namespace where nspname = 'net') then
      -- 1. Reconcile in-flight notifications if the response table exists
      if exists (
        select 1 from information_schema.tables
        where table_schema = 'net' and table_name = '_http_response'
      ) then
        -- Confirmed 2xx delivery sets notified_at
        update public.indexer_alerts a
        set notified_at = v_now,
            notify_request_id = null
        from net._http_response r
        where a.notify_request_id = r.id
          and r.status_code >= 200 and r.status_code < 300
          and a.notified_at is null;
        get diagnostics v_notified = row_count;

        -- Failed or non-2xx delivery clears notify_request_id so alert retries
        update public.indexer_alerts a
        set notify_request_id = null
        from net._http_response r
        where a.notify_request_id = r.id
          and (r.status_code < 200 or r.status_code >= 300 or r.error_msg is not null or r.timed_out = true)
          and a.notified_at is null;
      end if;

      -- 2. Dispatch pending or retrying alerts
      if v_webhook is not null then
        for v_alert in
          select a.id, a.kind, a.subject, a.detail
          from public.indexer_alerts a
          where a.resolved_at is null
            and a.notified_at is null
            and a.notify_request_id is null
          order by a.opened_at
        loop
          select net.http_post(
            url := v_webhook,
            headers := jsonb_build_object('content-type', 'application/json'),
            body := jsonb_build_object(
              'content',
              format(
                'Susu indexer alert — %s (%s) at %s: %s',
                v_alert.kind,
                v_alert.subject,
                to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                v_alert.detail::text
              )
            ),
            timeout_milliseconds := 10000
          ) into v_request_id;

          update public.indexer_alerts
          set notify_request_id = v_request_id
          where id = v_alert.id;
        end loop;
      end if;
    end if;
  end if;

  opened := v_after - v_before;
  resolved := v_resolved;
  open_now := (select count(*)::integer from public.indexer_alerts where resolved_at is null);
  notified := v_notified;
  return next;
end;
$function$;

comment on function public.check_indexer_health(interval, interval, boolean, bigint) is
  'Opens, refreshes and resolves indexer health alerts, with asynchronous webhook confirmation ensuring at-least-once delivery.';

-- Only the scheduler and trusted server code run this; a browser never does.
revoke all on function public.check_indexer_health(interval, interval, boolean, bigint) from public;
revoke all on function public.check_indexer_health(interval, interval, boolean, bigint) from anon, authenticated;
grant execute on function public.check_indexer_health(interval, interval, boolean, bigint) to service_role;
