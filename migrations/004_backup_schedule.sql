insert into system_settings (key, value) values
  ('backup_weekdays', '1,4'),
  ('backup_time', '03:00'),
  ('backup_timezone', 'America/Argentina/Buenos_Aires')
on conflict (key) do nothing;
