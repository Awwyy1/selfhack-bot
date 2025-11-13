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

    // ========== ОБРАБОТКА CALLBACK (КНОПОК) ==========
    if (update.callback_query) {
      const callbackData = update.callback_query.data;
      const callbackChatId = update.callback_query.message.chat.id;
      const callbackUserId = update.callback_query.from.id;

      if (callbackData === 'buy_premium' || callbackData === 'buy_pro') {
        const amount = callbackData === 'buy_premium' ? '10.99' : '25.99';
        const plan = callbackData === 'buy_premium' ? 'Premium' : 'Pro';

        try {
          const { createInvoice } = await import('../lib/cryptobot.js');
          const invoice = await createInvoice(
            amount,
            `SelfHack ${plan} (1 месяц)`,
            callbackUserId
          );

          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: callbackChatId,
              text: `💳 Оплати ${plan} ($${amount}):\n\nОткрой ссылку для оплаты:`,
              reply_markup: {
                inline_keyboard: [[
                  { text: `💰 Оплатить ${amount} USDT`, url: invoice.bot_invoice_url }
                ]]
              }
            })
          });

          // Сохранить invoice_id для проверки позже
          await supabase.from('pending_payments').insert({
            telegram_user_id: callbackUserId,
            invoice_id: invoice.invoice_id,
            plan: plan.toLowerCase(),
            amount: amount,
            created_at: new Date()
          });

        } catch (error) {
          console.error('❌ Payment error:', error);
          await sendMessage(BOT_TOKEN, callbackChatId, 'Ошибка создания инвойса. Попробуй /premium ещё раз.');
        }
      }

      return res.status(200).json({ ok: true });
    }    
    
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

      // ========== КОМАНДА /premium ==========
    if (messageText === '/premium') {
      const premiumKeyboard = {
        inline_keyboard: [
          [
            { text: '💎 Premium $10.99/мес', callback_data: 'buy_premium' },
            { text: '🏆 Pro $25.99/мес', callback_data: 'buy_pro' }
          ]
        ]
      };

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '🚀 Выбери тариф:\n\n💎 **Premium** ($10.99/мес):\n- Безлимитные сообщения\n- 5 целей\n- История 30 дней\n\n🏆 **Pro** ($25.99/мес):\n- Всё из Premium\n- AI-анализ\n- Отчёты\n- Голосовые сообщения',
          parse_mode: 'Markdown',
          reply_markup: premiumKeyboard
        })
      });

      return res.status(200).json({ ok: true });
    }    
    
    // ========== КОМАНДА /checkin ==========
    if (messageText === '/checkin') {
      const today = new Date().toISOString().split('T')[0];
      
      const { data: existingCheckin } = await supabase
        .from('checkins')
        .select('*')
        .eq('telegram_user_id', userId)
        .eq('checkin_date', today)
        .maybeSingle();

      if (existingCheckin) {
        await sendMessage(BOT_TOKEN, chatId, '✅ Ты уже сделал чекин сегодня! Увидимся завтра.');
        return res.status(200).json({ ok: true });
      }

      const { error: insertError } = await supabase
        .from('checkins')
        .insert({ telegram_user_id: userId, checkin_date: today });

      if (insertError) {
        console.error('❌ Checkin error:', insertError);
        await sendMessage(BOT_TOKEN, chatId, 'Ошибка при чекине. Попробуй ещё раз?');
        return res.status(200).json({ ok: true });
      }

      const { data: allCheckins } = await supabase
        .from('checkins')
        .select('checkin_date')
        .eq('telegram_user_id', userId)
        .order('checkin_date', { ascending: false });

      let streak = 1;
      if (allCheckins && allCheckins.length > 1) {
        for (let i = 0; i < allCheckins.length - 1; i++) {
          const current = new Date(allCheckins[i].checkin_date);
          const next = new Date(allCheckins[i + 1].checkin_date);
          const diffDays = (current - next) / (1000 * 60 * 60 * 24);
          if (diffDays === 1) {
            streak++;
          } else {
            break;
          }
        }
      }

      const streakMessage = streak > 1 
        ? `🔥 Чекин выполнен! Твой streak: ${streak} дней подряд. Продолжай!` 
        : '✅ Чекин выполнен! Начинаем отсчёт streak.';

      await sendMessage(BOT_TOKEN, chatId, streakMessage);
      console.log(`✅ Checkin: user ${userId}, streak ${streak}`);
      return res.status(200).json({ ok: true });
    }
    
    // ========== ОБРАБОТКА ОБЫЧНОГО СООБЩЕНИЯ ==========
    
    // Показать индикатор "печатает..."
    await sendChatAction(BOT_TOKEN, chatId, 'typing');

    // Загрузить ПОСЛЕДНИЕ 50 сообщений
    const { data: historyData, error: historyError } = await supabase
      .from('telegram_chats')
      .select('role, content')
      .eq('telegram_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (historyError) {
      console.error('❌ History load error:', historyError);
    }

    // Развернуть обратно (старые → новые для Claude API)
    const conversationHistory = historyData ? historyData.reverse() : [];
    
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
