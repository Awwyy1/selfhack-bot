import { supabase } from '../lib/supabase.js';
import { anthropic, COACHING_SYSTEM } from '../lib/claude.js';
import { sendMessage, sendChatAction } from '../lib/telegram.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MODEL = 'claude-sonnet-4-5-20250929';

export default async function handler(req, res) {
  // Разрешаем только POST запросы от Telegram
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const update = req.body;
    
    // Проверяем что это текстовое сообщение
    if (!update.message || !update.message.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const username = update.message.from.username || update.message.from.first_name;
    const messageText = update.message.text.trim();

    console.log(`📩 Message from @${username} (${userId}): ${messageText}`);

    // ========== КОМАНДА /start ==========
    if (messageText === '/start') {
      const welcomeMessage = `Привет! Я не советчик — я коуч, который задаёт вопросы.\n\nЧто ты хочешь изменить прямо сейчас?\n\nПобороть прокрастинацию? Найти фокус? Разобраться с целями? Или у тебя свой запрос?\n\nПиши мне — попробуем решить.`;
      await sendMessage(BOT_TOKEN, chatId, welcomeMessage);
      return res.status(200).json({ ok: true });
    }

    // ========== КОМАНДА /clear ==========
    if (messageText === '/clear') {
      const { error } = await supabase
        .from('telegram_chats')
        .delete()
        .eq('telegram_user_id', userId);

      if (error) {
        console.error('❌ Clear history error:', error);
        await sendMessage(BOT_TOKEN, chatId, 'Oops, couldn\'t clear history. Try again?');
      } else {
        await sendMessage(BOT_TOKEN, chatId, '✅ Chat history cleared! Fresh start.');
        console.log(`🗑️ History cleared for user ${userId}`);
      }
      return res.status(200).json({ ok: true });
    }

    // ========== КОМАНДА /stats ==========
    if (messageText === '/stats') {
      const { data, error } = await supabase
        .from('telegram_chats')
        .select('role', { count: 'exact' })
        .eq('telegram_user_id', userId);

      if (error) {
        console.error('❌ Stats error:', error);
        await sendMessage(BOT_TOKEN, chatId, 'Couldn\'t fetch stats. Try again?');
      } else {
        const userMessages = data.filter(m => m.role === 'user').length;
        const aiMessages = data.filter(m => m.role === 'assistant').length;
        const total = data.length;

        const statsMessage = `📊 *Your Stats:*\n\n` +
          `Total messages: ${total}\n` +
          `Your messages: ${userMessages}\n` +
          `AI responses: ${aiMessages}`;

        await sendMessage(BOT_TOKEN, chatId, statsMessage);
      }
      return res.status(200).json({ ok: true });
    }

    // ========== ОБРАБОТКА ОБЫЧНОГО СООБЩЕНИЯ ==========
    
    // Показать индикатор "печатает..."
    await sendChatAction(BOT_TOKEN, chatId, 'typing');

    // Загрузить ВСЮ историю чата (не только 5 последних)
    const { data: historyData, error: historyError } = await supabase
      .from('telegram_chats')
      .select('role, content')
      .eq('telegram_user_id', userId)
      .order('created_at', { ascending: true }); // ВСЯ ИСТОРИЯ

    if (historyError) {
      console.error('❌ History load error:', historyError);
    }

    const conversationHistory = historyData || [];
    
    console.log(`📚 Loaded ${conversationHistory.length} messages from history`);

    // Добавить текущее сообщение юзера
    const messages = [
      ...conversationHistory,
      { role: 'user', content: messageText }
    ];

    // Отправить в Claude API
    const aiResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      temperature: 0.8,
      system: COACHING_SYSTEM,
      messages: messages
    });

    const reply = aiResponse.content[0].text;
    const wordCount = reply.split(/\s+/).length;

    console.log(`🤖 AI Response (${wordCount} words): ${reply}`);

    // Сохранить сообщение юзера в БД
    await supabase.from('telegram_chats').insert({
      telegram_user_id: userId,
      role: 'user',
      content: messageText
    });

    // Сохранить ответ AI в БД
    await supabase.from('telegram_chats').insert({
      telegram_user_id: userId,
      role: 'assistant',
      content: reply
    });

    // Отправить ответ в Telegram
    await sendMessage(BOT_TOKEN, chatId, reply);

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    
    // Попытаться отправить сообщение об ошибке юзеру
    if (req.body?.message?.chat?.id) {
      try {
        await sendMessage(
          BOT_TOKEN, 
          req.body.message.chat.id, 
          'Sorry, something went wrong. Please try again in a moment.'
        );
      } catch (e) {
        console.error('❌ Failed to send error message:', e);
      }
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
}
