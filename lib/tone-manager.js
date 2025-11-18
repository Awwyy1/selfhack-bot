import { supabase } from './supabase.js';
import { FOCUSED_PROMPT } from './prompts/focused.js';
import { BADDY_PROMPT } from './prompts/baddy.js';
import { MENTOR_PROMPT } from './prompts/mentor.js';

// Получить системный промпт по тональности
export function getPromptByTone(tone) {
  switch (tone) {
    case 'focused':
      return FOCUSED_PROMPT;
    case 'baddy':
      return BADDY_PROMPT;
    case 'mentor':
      return MENTOR_PROMPT;
    default:
      return BADDY_PROMPT; // Дефолт
  }
}

// Получить тональность пользователя
export async function getUserTone(userId) {
  const { data } = await supabase
    .from('user_preferences')
    .select('tone')
    .eq('telegram_user_id', userId)
    .maybeSingle();

  return data?.tone || 'baddy'; // Дефолт: baddy
}

// Установить тональность
export async function setUserTone(userId, tone) {
  await supabase
    .from('user_preferences')
    .upsert({
      telegram_user_id: userId,
      tone: tone,
      updated_at: new Date()
    });
}

// Получить название тональности для отображения
export function getToneName(tone) {
  const names = {
    focused: '⚡ Focused',
    baddy: '💬 Baddy',
    mentor: '👔 Mentor'
  };
  return names[tone] || names.baddy;
}

// Получить описание тональности
export function getToneDescription(tone) {
  const descriptions = {
    focused: 'Минимум слов, максимум действий',
    baddy: 'Как с другом, который не даёт врать себе',
    mentor: 'Вежливо, структурированно, как бизнес-коуч'
  };
  return descriptions[tone] || descriptions.baddy;
}

// Проверить доступна ли тональность для FREE юзера
export function isToneAvailableForFree(tone) {
  return tone === 'focused' || tone === 'baddy';
}
