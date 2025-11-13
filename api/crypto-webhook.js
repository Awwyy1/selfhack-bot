import { supabase } from '../lib/supabase.js';
import { sendMessage } from '../lib/telegram.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { invoice_id, status } = req.body;

    if (status === 'paid') {
      const { data: payment } = await supabase
        .from('pending_payments')
        .select('*')
        .eq('invoice_id', invoice_id)
        .single();

      if (payment) {
        // Активировать подписку
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1);

        await supabase.from('subscriptions').upsert({
          telegram_user_id: payment.telegram_user_id,
          plan: payment.plan,
          expires_at: expiresAt,
          status: 'active'
        });

        await supabase.from('pending_payments')
          .update({ status: 'paid' })
          .eq('invoice_id', invoice_id);

        await sendMessage(
          BOT_TOKEN,
          payment.telegram_user_id,
          `🎉 Оплата прошла! ${payment.plan} активирован до ${expiresAt.toLocaleDateString('ru-RU')}`
        );
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Crypto webhook error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}
