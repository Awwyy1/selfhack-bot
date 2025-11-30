import { supabase } from '../lib/supabase.js';
import { anthropic } from '../lib/claude.js';
import { sendMessage, sendChatAction } from '../lib/telegram.js';
import { checkAndCreateSummary, loadConversationWithSummaries } from '../lib/summarizer.js';
import { getUserTone, setUserTone, getPromptByTone, getToneName, getToneDescription, isToneAvailableForFree } from '../lib/tone-manager.js';

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

      // Обработка покупки Premium/Pro
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

      // Обработка выбора тональности
      if (callbackData.startsWith('tone_')) {
        const selectedTone = callbackData.replace('tone_', '');

        // Проверка подписки для Mentor
        if (selectedTone === 'mentor') {
          const { data: subscription } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('telegram_user_id', callbackUserId)
            .eq('status', 'active')
            .maybeSingle();

          const isPremium = subscription && new Date(subscription.expires_at) > new Date();

          if (!isPremium) {
            // Показать попап Premium
            const premiumKeyboard = {
              inline_keyboard: [
                [
                  { text: '💰 Купить Premium', callback_data: 'buy_premium' }
                ],
                [
                  { text: '⬅️ Назад к выбору', callback_data: 'tone_back_to_selection' }
                ]
              ]
            };

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: callbackChatId,
                text: '💎 Стиль Mentor доступен в Premium\n\nPremium ($10.99/мес):\n- Безлимитные сообщения\n- 3 тональности коуча\n- История 30 дней',
                reply_markup: premiumKeyboard
              })
            });

            return res.status(200).json({ ok: true });
          }
        }

        // Активировать тональность
        await setUserTone(callbackUserId, selectedTone);

        const toneName = getToneName(selectedTone);
        const toneDesc = getToneDescription(selectedTone);

        await sendMessage(BOT_TOKEN, callbackChatId,
          `✅ Стиль активирован: ${toneName}\n${toneDesc}\n\nЧто хочешь изменить прямо сейчас?`
        );

        return res.status(200).json({ ok: true });
      }

      // Возврат к выбору тональности
      if (callbackData === 'tone_back_to_selection') {
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('*')
          .eq('telegram_user_id', callbackUserId)
          .eq('status', 'active')
          .maybeSingle();

        const isPremium = subscription && new Date(subscription.expires_at) > new Date();

        const toneKeyboard = {
          inline_keyboard: [
            [
              { text: '⚡ Focused', callback_data: 'tone_focused' },
              { text: '💬 Baddy', callback_data: 'tone_baddy' }
            ],
            [
              { text: isPremium ? '👔 Mentor' : '🔒 Mentor - Premium', callback_data: 'tone_mentor' }
            ]
          ]
        };

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: callbackChatId,
            text: '🎨 Выбери стиль коуча:\n\n⚡ Focused - Минимум слов, максимум действий\n\n💬 Baddy - Как с другом, который не даёт врать себе\n\n👔 Mentor - Вежливо, структурированно, как бизнес-коуч',
            reply_markup: toneKeyboard
          })
        });

        return res.status(200).json({ ok: true });
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
      // Проверить есть ли уже выбранная тональность
      const { data: existingPreference } = await supabase
        .from('user_preferences')
        .select('tone')
        .eq('telegram_user_id', userId)
        .maybeSingle();

      if (!existingPreference) {
        // Первый раз - показать выбор тональности
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('*')
          .eq('telegram_user_id', userId)
          .eq('status', 'active')
          .maybeSingle();

        const isPremium = subscription && new Date(subscription.expires_at) > new Date();

        const toneKeyboard = {
          inline_keyboard: [
            [
              { text: '⚡ Focused', callback_data: 'tone_focused' },
              { text: '💬 Baddy', callback_data: 'tone_baddy' }
            ],
            [
              { text: isPremium ? '👔 Mentor' : '🔒 Mentor - Premium', callback_data: 'tone_mentor' }
            ]
          ]
        };

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '🎨 Привет! Выбери стиль коуча:\n\n⚡ Focused - Минимум слов, максимум действий\n\n💬 Baddy - Как с другом, который не даёт врать себе\n\n👔 Mentor - Вежливо, структурированно, как бизнес-коуч\n\nМожешь сменить в любой момент через /tone',
            reply_markup: toneKeyboard
          })
        });
      } else {
        // Уже есть тональность - обычное приветствие
        const welcomeMessage = `Привет! Я не советчик — я коуч, который задаёт вопросы.\n\nЧто ты хочешь изменить прямо сейчас?\n\nПобороть прокрастинацию? Найти фокус? Разобраться с целями? Или у тебя свой запрос?\n\nПиши мне — попробуем решить.`;
        await sendMessage(BOT_TOKEN, chatId, welcomeMessage);
      }
      
      return res.status(200).json({ ok: true });
    }

    // ========== КОМАНДА /tone ==========
    if (messageText === '/tone') {
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('telegram_user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      const isPremium = subscription && new Date(subscription.expires_at) > new Date();
      const currentTone = await getUserTone(userId);
      const toneName = getToneName(currentTone);

      const toneKeyboard = {
        inline_keyboard: [
          [
            { text: '⚡ Focused', callback_data: 'tone_focused' },
            { text: '💬 Baddy', callback_data: 'tone_baddy' }
          ],
          [
            { text: isPremium ? '👔 Mentor' : '🔒 Mentor - Premium', callback_data: 'tone_mentor' }
          ]
        ]
      };

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🎨 Текущий стиль: ${toneName}\n\nВыбери новый:`,
          reply_markup: toneKeyboard
        })
      });

      return res.status(200).json({ ok: true });
    }

    // ========== КОМАНДА /clear ==========
    if (messageText === '/clear') {
      // Удалить историю чата
      await supabase
        .from('telegram_chats')
        .delete()
        .eq('telegram_user_id', userId);

      // Удалить summaries
      await supabase
        .from('message_summaries')
        .delete()
        .eq('telegram_user_id', userId);

      await sendMessage(BOT_TOKEN, chatId, '✅ Chat history cleared! Fresh start.');
      console.log(`🗑️ History cleared for user ${userId}`);
      
      return res.status(200).json({ ok: true });
    }

    // ========== КОМАНДА /stats ==========
    if (messageText === '/stats') {
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('telegram_user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      const isPremium = subscription && new Date(subscription.expires_at) > new Date();

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

        // Получить streak
        const { data: allCheckins } = await supabase
          .from('checkins')
          .select('checkin_date')
          .eq('telegram_user_id', userId)
          .order('checkin_date', { ascending: false });

        let streak = 0;
        if (allCheckins && allCheckins.length > 0) {
          const today = new Date().toISOString().split('T')[0];
          const lastCheckin = allCheckins[0].checkin_date;
          
          // Проверить был ли чекин сегодня или вчера
          const lastCheckinDate = new Date(lastCheckin);
          const todayDate = new Date(today);
          const diffDays = Math.floor((todayDate - lastCheckinDate) / (1000 * 60 * 60 * 24));
          
          if (diffDays <= 1) {
            streak = 1;
            for (let i = 0; i < allCheckins.length - 1; i++) {
              const current = new Date(allCheckins[i].checkin_date);
              const next = new Date(allCheckins[i + 1].checkin_date);
              const diff = (current - next) / (1000 * 60 * 60 * 24);
              if (diff === 1) {
                streak++;
              } else {
                break;
              }
            }
          }
        }

        let planInfo = '';
        if (isPremium) {
          const planName = subscription.plan === 'premium' ? '💎 Premium' : '🏆 Pro';
          const expiresDate = new Date(subscription.expires_at).toLocaleDateString('ru-RU');
          planInfo = `Тариф: ${planName} (до ${expiresDate})\n\n`;
        } else {
          const remaining = 50 - userMessages;
          planInfo = `Тариф: 📦 FREE (осталось ${remaining}/50 сообщений)\n\n`;
        }

        const streakInfo = streak > 0 ? `🔥 Streak: ${streak} дней подряд\n` : '';

        const statsMessage = `📊 *Твоя статистика:*\n\n${planInfo}${streakInfo}` +
          `Всего сообщений: ${total}\n` +
          `Твоих: ${userMessages}\n` +
          `От AI: ${aiMessages}`;

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
          text: '🚀 Выбери тариф:\n\n💎 **Premium** ($10.99/мес):\n- Безлимитные сообщения\n- 3 тональности коуча\n- История 30 дней\n\n🏆 **Pro** ($25.99/мес):\n- Всё из Premium\n- Безлимитная история\n- Еженедельные отчёты\n- Приоритетная поддержка',
          parse_mode: 'Markdown',
          reply_markup: premiumKeyboard
        })
      });

      return res.status(200).json({ ok: true });
    }

    // ========== КОМАНДА /activate ==========
    if (messageText.startsWith('/activate ')) {
      const promoCode = messageText.replace('/activate ', '').trim().toUpperCase();

      const { data: promo, error: promoError } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', promoCode)
        .maybeSingle();

      if (!promo) {
        await sendMessage(BOT_TOKEN, chatId, '❌ Промокод не найден или уже использован.');
        return res.status(200).json({ ok: true });
      }

      if (promo.used_count >= promo.max_uses) {
        await sendMessage(BOT_TOKEN, chatId, '❌ Промокод уже использован максимальное количество раз.');
        return res.status(200).json({ ok: true });
      }

      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        await sendMessage(BOT_TOKEN, chatId, '❌ Промокод истёк.');
        return res.status(200).json({ ok: true });
      }

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      await supabase.from('subscriptions').upsert({
        telegram_user_id: userId,
        plan: promo.plan,
        expires_at: expiresAt,
        status: 'active'
      });

      await supabase.from('promo_codes')
        .update({ used_count: promo.used_count + 1 })
        .eq('code', promoCode);

      const planName = promo.plan === 'premium' ? 'Premium' : 'Pro';
      await sendMessage(
        BOT_TOKEN,
        chatId,
        `🎉 Промокод активирован! ${planName} доступен до ${expiresAt.toLocaleDateString('ru-RU')}`
      );

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

    // ========== ПРОВЕРКА ЛИМИТОВ FREE ==========
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('telegram_user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    const isPremium = subscription && new Date(subscription.expires_at) > new Date();

    if (!isPremium) {
      const { count: totalMessages } = await supabase
        .from('telegram_chats')
        .select('*', { count: 'exact', head: true })
        .eq('telegram_user_id', userId)
        .eq('role', 'user');

      const FREE_LIMIT = 50;

      if (totalMessages >= FREE_LIMIT) {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `📦 Ты достиг лимита FREE тарифа (${FREE_LIMIT} сообщений).\n\nДля продолжения:\n💎 /premium — купить подписку\n🎟️ /activate [код] — активировать промокод`
        );
        return res.status(200).json({ ok: true });
      }

      if (totalMessages === FREE_LIMIT - 5) {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `⚠️ Осталось 5 сообщений FREE тарифа.\n\nПолучи безлимит: /premium`
        );
      }
    }

    // ========== ОБРАБОТКА ОБЫЧНОГО СООБЩЕНИЯ ==========
    
    await sendChatAction(BOT_TOKEN, chatId, 'typing');

    // Получить тональность пользователя
    const userTone = await getUserTone(userId);
    const systemPrompt = getPromptByTone(userTone);

    // Загрузить историю с учетом summarization для Premium
    let conversationHistory = [];

    if (isPremium) {
      // Premium: проверить нужно ли создать summary, затем загрузить с summaries
      try {
        await checkAndCreateSummary(userId);
        conversationHistory = await loadConversationWithSummaries(userId, 50);
      } catch (summaryError) {
        console.error('⚠️ Summary error (fallback to regular history):', summaryError);
        // Fallback: если summarization упал, загрузить обычную историю
        const { data: historyData } = await supabase
          .from('telegram_chats')
          .select('role, content')
          .eq('telegram_user_id', userId)
          .order('created_at', { ascending: false })
          .limit(50);
        conversationHistory = historyData ? historyData.reverse() : [];
      }
    } else {
      // FREE: только последние 50 сообщений
      const { data: historyData } = await supabase
        .from('telegram_chats')
        .select('role, content')
        .eq('telegram_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      conversationHistory = historyData ? historyData.reverse() : [];
    }
    
    console.log(`📚 Loaded ${conversationHistory.length} messages from history (Premium: ${isPremium}, Tone: ${userTone})`);

    const messages = [
      ...conversationHistory,
      { role: 'user', content: messageText }
    ];

    const aiResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      temperature: 0.8,
      system: systemPrompt,
      messages: messages
    });

    const reply = aiResponse.content[0].text;
    const wordCount = reply.split(/\s+/).length;

    console.log(`🤖 AI Response (${wordCount} words, tone: ${userTone}): ${reply}`);

    await supabase.from('telegram_chats').insert({
      telegram_user_id: userId,
      role: 'user',
      content: messageText
    });

    await supabase.from('telegram_chats').insert({
      telegram_user_id: userId,
      role: 'assistant',
      content: reply
    });

    await sendMessage(BOT_TOKEN, chatId, reply);

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    
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
