// Cloudflare Worker: проверяет подпись данных от Telegram Login Widget.
//
// Как это работает: Telegram Login Widget на странице после успешного входа
// отдаёт JS-объект { id, first_name, username?, photo_url?, auth_date, hash }.
// hash — это HMAC-SHA256 от всех остальных полей, посчитанный на стороне
// Telegram ключом, производным от токена бота (secret_key = SHA256(bot_token)).
// Подделать этот hash, не зная токен бота, невозможно — значит, если мы
// пересчитаем тот же HMAC на своей стороне (зная токен) и он совпадёт,
// значит пользователь действительно прошёл через настоящий Telegram-логин
// под этим telegram id, а не просто вписал его в JS консоли браузера.
//
// Секрет (BOT_TOKEN) хранится только здесь, в переменных окружения Worker'а
// (Cloudflare Dashboard → этот Worker → Settings → Variables and Secrets) —
// никогда не попадает в клиентский код игры и не коммитится в этот репозиторий.
//
// Деплой: этот Worker подключён к GitHub (Cloudflare Dashboard → Workers &
// Pages → Create → Connect to Git → репозиторий battle-admin-bot, root
// directory = cloudflare/telegram-login-verify) — при каждом пуше в main
// Cloudflare пересобирает и обновляет Worker автоматически.
//
// Не забудь также один раз выполнить /setdomain у @BotFather для домена,
// на котором открывается игра — иначе сам виджет Telegram Login откажется
// работать на этом сайте.

const ALLOWED_ORIGIN = 'https://botsystemtioxsit.github.io'; // поменяй на реальный домен игры, если он другой

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function hmacSha256Hex(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ valid: false, error: 'bad_json' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const { hash, ...fields } = payload || {};
    if (!hash || !fields.id || !fields.auth_date) {
      return new Response(JSON.stringify({ valid: false, error: 'missing_fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // Защита от повторного использования старой подписи — Telegram
    // рекомендует отклонять auth_date старше суток
    const authAgeSeconds = Math.floor(Date.now() / 1000) - Number(fields.auth_date);
    if (authAgeSeconds > 86400 || authAgeSeconds < -60) {
      return new Response(JSON.stringify({ valid: false, error: 'stale_auth_date' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // Строка для проверки — все поля кроме hash, отсортированные по ключу,
    // в формате key=value через \n (см. https://core.telegram.org/widgets/login#checking-authorization)
    const dataCheckString = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join('\n');

    const secretKeyBytes = await sha256Bytes(env.BOT_TOKEN);
    const computedHash = await hmacSha256Hex(secretKeyBytes, dataCheckString);

    if (computedHash !== hash) {
      return new Response(JSON.stringify({ valid: false, error: 'bad_signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    return new Response(
      JSON.stringify({
        valid: true,
        id: String(fields.id),
        first_name: fields.first_name || null,
        username: fields.username || null,
        photo_url: fields.photo_url || null,
      }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  },
};
