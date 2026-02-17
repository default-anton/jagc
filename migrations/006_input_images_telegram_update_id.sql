ALTER TABLE input_images ADD COLUMN telegram_update_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS input_images_telegram_update_idx
  ON input_images (source, thread_key, user_key, telegram_update_id)
  WHERE telegram_update_id IS NOT NULL;
