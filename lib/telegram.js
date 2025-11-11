const TELEGRAM_API = 'https://api.telegram.org';

// Отправка сообщения в Telegram
export async function sendMessage(botToken, chatId, text) {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown' // Поддержка **bold**, *italic*
      })
    });

    const data = await response.json();
    
    if (!data.ok) {
      console.error('❌ Telegram sendMessage error:', data);
      throw new Error(data.description || 'Failed to send message');
    }

    return data.result;
  } catch (error) {
    console.error('❌ Telegram API error:', error);
    throw error;
  }
}

// Показать индикатор "печатает..."
export async function sendChatAction(botToken, chatId, action = 'typing') {
  const url = `${TELEGRAM_API}/bot${botToken}/sendChatAction`;
  
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        action: action
      })
    });
  } catch (error) {
    console.error('⚠️ Chat action error (non-critical):', error);
  }
}
