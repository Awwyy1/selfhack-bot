const CRYPTOBOT_API = 'https://pay.crypt.bot/api';
const API_TOKEN = process.env.CRYPTOBOT_API_TOKEN;

export async function createInvoice(amount, description, userId) {
  const response = await fetch(`${CRYPTOBOT_API}/createInvoice`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      asset: 'USDT',
      amount: amount,
      description: description,
      payload: userId.toString(),
      paid_btn_name: 'callback',
      paid_btn_url: `https://t.me/ai_selfhack_bot`
    })
  });

  const data = await response.json();
  if (!data.ok) throw new Error(data.error.name);
  return data.result;
}

export async function checkInvoice(invoiceId) {
  const response = await fetch(`${CRYPTOBOT_API}/getInvoices?invoice_ids=${invoiceId}`, {
    headers: { 'Crypto-Pay-API-Token': API_TOKEN }
  });

  const data = await response.json();
  if (!data.ok) throw new Error(data.error.name);
  return data.result.items[0];
}
