-- 部署到 Vercel 后再执行本文件。
-- 先把下面两个占位值替换为正式域名和 Vercel 中相同的 CLEANUP_SECRET。

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(
  'https://your-project.vercel.app/api/maintenance/expire-orders',
  'sms_cleanup_url'
);

select vault.create_secret(
  'replace_with_the_same_cleanup_secret_as_vercel',
  'sms_cleanup_secret'
);

select cron.schedule(
  'release-expired-sms-orders',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sms_cleanup_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'sms_cleanup_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
