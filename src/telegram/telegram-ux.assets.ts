

import type { ConfigService } from '@nestjs/config';

export type TelegramUxAssets = Readonly<{
  stickerChecking: string | undefined;
  stickerCooldown: string | undefined;
  stickerSuccess: string | undefined;
  animationLoading: string | undefined;
}>;

function trimEnv(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

export function loadTelegramUxAssets(config: ConfigService): TelegramUxAssets {
  return Object.freeze({
    stickerChecking: trimEnv(config.get('TELEGRAM_STICKER_CHECKING')),
    stickerCooldown: trimEnv(config.get('TELEGRAM_STICKER_WAIT')),
    stickerSuccess: trimEnv(config.get('TELEGRAM_STICKER_SUCCESS')),
    animationLoading: trimEnv(config.get('TELEGRAM_ANIMATION_LOADING')),
  });
}
