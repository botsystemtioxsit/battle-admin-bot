// Проверка рассылок (src/mailer.mjs) на подставных Telegram и базе — без сети.
// Запуск: node cloudflare-worker/role-gateway/test/mailer.test.mjs
import { createMailer, sanitizeCampaign, renderText, inHours, classifyError, cleanBody, LIMITS, DAY_MS } from '../src/mailer.mjs';

let bad = 0;
const t = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); if (!cond) bad++; };

function makeDb() {
  const root = {};
  const setPath = (path, value) => {
    const parts = path.split('/');
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof n[parts[i]] !== 'object' || n[parts[i]] === null) n[parts[i]] = {}; n = n[parts[i]]; }
    const last = parts.at(-1);
    if (value === null) delete n[last];
    else if (value && typeof value === 'object' && value['.sv'] && value['.sv'].increment !== undefined) n[last] = (Number(n[last]) || 0) + value['.sv'].increment;
    else n[last] = JSON.parse(JSON.stringify(value));
  };
  const get = (path) => path.split('/').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), root) ?? null;
  return { root, writes: [],
    async dbGet(path, o) { const v = get(path); return o && o.shallow && v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).map((k) => [k, true])) : v; },
    async dbUpdate(u) { this.writes.push(u); for (const [p, v] of Object.entries(u)) setPath(p, v); } };
}

const NOW0 = Date.parse('2026-11-11T12:00:00Z'); // 13:00 в Берлине
const MAIN_ID = 7000000001;
const TOKEN_A = '111111111:AAAA-bbbbCCCCddddEEEEffffGGGGhhhh12';
const TOKEN_B = '222222222:ZZZZ-yyyyXXXXwwwwVVVVuuuuTTTTss34';
const KEY_RE = /^mailer(\/[A-Za-z0-9_-]{1,64}){0,8}$/;
const C1 = '-1001111111111', C2 = '-1002222222222';

function makeEnv({ main = {}, tokens = {}, sendResult = {} } = {}) {
  const db = makeDb();
  const clock = { t: NOW0 };
  const calls = []; // { who, method, payload }
  const tokenToBot = { [TOKEN_A]: { id: 111111111, username: 'helper_a_bot', first_name: 'Помощник А', is_bot: true }, [TOKEN_B]: { id: 222222222, username: 'helper_b_bot', first_name: 'Помощник Б', is_bot: true }, ...tokens };
  const reply = (who, method, payload) => {
    const key = who + ':' + method;
    if (sendResult[key]) return typeof sendResult[key] === 'function' ? sendResult[key](payload) : sendResult[key];
    if (method === 'sendMessage') return { ok: true, result: { message_id: 1 } };
    if (method === 'getChat') return { ok: true, result: { id: payload.chat_id === '@my_channel' ? -1003333333333 : payload.chat_id, title: 'Чат ' + payload.chat_id, type: 'supergroup' } };
    if (method === 'getChatMember') return { ok: true, result: { status: 'member' } };
    return { ok: true, result: true };
  };
  const deps = {
    tg: async (method, payload) => { calls.push({ who: 'main', method, payload }); return reply('main', method, payload); },
    tgWithToken: async (token, method, payload) => {
      const bot = tokenToBot[token];
      if (method === 'getMe') return bot ? { ok: true, result: bot } : { ok: false, description: 'Unauthorized' };
      const who = bot ? String(bot.id) : 'unknown';
      calls.push({ who, method, payload, token });
      return reply(who, method, payload);
    },
    mainBot: async () => ({ id: main.id || MAIN_ID, username: main.username || 'main_bot' }),
    seal: async (text) => 'ENC:' + Buffer.from(String(text)).reverse().toString('base64'),
    unseal: async (enc) => { if (!String(enc).startsWith('ENC:')) throw new Error('плохой шифр'); return Buffer.from(String(enc).slice(4), 'base64').reverse().toString(); },
    dbGet: (p, o) => db.dbGet(p, o), dbUpdate: (u) => db.dbUpdate(u), now: () => clock.t,
  };
  return { db, calls, deps, clock, m: createMailer(deps), sends: () => calls.filter((c) => c.method === 'sendMessage') };
}
const input = (over = {}) => ({ name: 'Анонсы', chats: [C1, C2], senders: ['main'], variants: [{ text: 'Привет, {chat}! Сегодня {date}' }, { text: 'Второй вариант' }], order: 'cycle', everyMin: 60, perDay: 6, tz: 'Europe/Berlin', hours: { from: 9, to: 22 }, ...over });
async function withCampaign(over = {}, envOpts) {
  const e = makeEnv(envOpts);
  const r = await e.m.save(input(over));
  e.id = r.id;
  return e;
}

// ---------- чистые функции ----------
t('очистка текста: переводы строк сохраняются, мусор убирается', cleanBody('  Привет\r\n\r\n\r\n\r\nмир ‮ \u0000 ') === 'Привет\n\nмир', JSON.stringify(cleanBody('  Привет\r\n\r\n\r\n\r\nмир ‮ \u0000 ')));
t('подстановки {chat} и {date}', renderText('В «{chat}» {date}', { title: 'Наш чат', at: NOW0, tz: 'Europe/Berlin' }) === 'В «Наш чат» 11.11.2026');
t('тихие часы: внутри окна', inHours(NOW0, { from: 9, to: 22 }, 'Europe/Berlin') === true);
t('тихие часы: вне окна (23:00 в Берлине)', inHours(Date.parse('2026-11-11T22:00:00Z'), { from: 9, to: 22 }, 'Europe/Berlin') === false);
t('тихие часы: окно через полночь (22–6)', inHours(Date.parse('2026-11-11T22:30:00Z'), { from: 22, to: 6 }, 'Europe/Berlin') === true && inHours(NOW0, { from: 22, to: 6 }, 'Europe/Berlin') === false);
t('тихие часы: from = to — всегда можно', inHours(Date.parse('2026-11-11T01:00:00Z'), { from: 0, to: 0 }, 'Europe/Berlin') === true);
t('ошибки: 429 — ждать', classifyError({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } }).kind === 'wait' && classifyError({ parameters: { retry_after: 7 } }).waitMs === 8000);
t('ошибки: бота нет в чате — отказ пары', classifyError({ ok: false, description: 'Bad Request: chat not found' }).kind === 'pair' && classifyError({ ok: false, description: 'Forbidden: bot was kicked from the supergroup chat' }).kind === 'pair' && classifyError({ ok: false, description: 'Forbidden: not enough rights to send text messages to the chat' }).kind === 'pair');
t('ошибки: сеть — временная', classifyError({ ok: false, description: 'timeout' }).kind === 'transient');

let s = sanitizeCampaign(input());
t('проверка рассылки: нормальная проходит', s.ok && s.value.everyMin === 60 && s.value.variants.length === 2 && s.value.order === 'cycle', s);
t('проверка: без названия', sanitizeCampaign(input({ name: '  ' })).ok === false);
t('проверка: без текстов', sanitizeCampaign(input({ variants: [{ text: '   ' }] })).ok === false);
t('проверка: без чатов и без ботов', sanitizeCampaign(input({ chats: [] })).ok === false && sanitizeCampaign(input({ senders: [] })).ok === false);
t('проверка: чат — только число или @имя', sanitizeCampaign(input({ chats: ['../../x', 'привет'] })).ok === false && sanitizeCampaign(input({ chats: ['@my_channel'] })).ok === true);
t('проверка: интервал не чаще 10 минут и не реже 7 суток', sanitizeCampaign(input({ everyMin: 5 })).ok === false && sanitizeCampaign(input({ everyMin: 20000 })).ok === false && sanitizeCampaign(input({ everyMin: 10 })).ok === true);
t('проверка: сообщений в сутки 1–48', sanitizeCampaign(input({ perDay: 0 })).ok === false && sanitizeCampaign(input({ perDay: 49 })).ok === false && sanitizeCampaign(input({ perDay: 48 })).ok === true);
t('проверка: часы 0–23 и часовой пояс', sanitizeCampaign(input({ hours: { from: 25, to: 3 } })).ok === false && sanitizeCampaign(input({ tz: 'Нигде/Никак' })).ok === false);
t('проверка: бот — только main или число', sanitizeCampaign(input({ senders: ['../x'] })).ok === false);
t('проверка: больше 20 вариантов — отказ', sanitizeCampaign(input({ variants: Array.from({ length: 21 }, (_, i) => ({ text: 'т' + i })) })).ok === false);
s = sanitizeCampaign(input({ variants: [{ text: 'a', btn: { text: 'Открыть', url: 'https://example.com/x' } }, { text: 'b', btn: { text: 'Плохо', url: 'javascript:alert(1)' } }, { text: 'c', btn: { text: 'Без https', url: 'http://example.com' } }] }));
t('проверка: кнопка только с https-ссылкой', s.ok && s.value.variants[0].btn && !s.value.variants[1].btn && !s.value.variants[2].btn, s.value && s.value.variants);

// ---------- боты-отправители ----------
{
  const e = makeEnv();
  let r = await e.m.addBot('не токен');
  t('бот: не токен — отказ без запроса к Telegram', r.ok === false && e.calls.length === 0);
  r = await e.m.addBot('333333333:' + 'x'.repeat(35));
  t('бот: Telegram не принял токен — отказ, в базу ничего', r.ok === false && !e.db.root.mailer);
  r = await e.m.addBot(TOKEN_A);
  t('бот: добавлен', r.ok === true && r.bot.id === '111111111' && r.bot.username === 'helper_a_bot', r);
  const dump = JSON.stringify(e.db.root);
  t('бот: токен в базе только зашифрованным', !dump.includes(TOKEN_A) && !dump.includes('AAAA-bbbb') && e.db.root.mailer.bots['111111111'].enc.startsWith('ENC:'), dump);
  const v = await e.m.view();
  t('бот: панели токен и шифр не отдаются', !JSON.stringify(v).includes('ENC:') && !JSON.stringify(v).includes('AAAA') && v.bots.length === 2 && v.bots[0].main === true && v.bots[1].username === 'helper_a_bot', v.bots);
  r = await e.m.addBot(TOKEN_A);
  t('бот: повторно — отказ', r.ok === false && r.text.includes('уже добавлен'));
  const main = makeEnv({ tokens: { [TOKEN_B]: { id: MAIN_ID, username: 'main_bot', is_bot: true } } });
  t('бот: главный бот под другим токеном — отказ', (await main.m.addBot(TOKEN_B)).text.includes('главный'));
  const notBot = makeEnv({ tokens: { [TOKEN_B]: { id: 5, username: 'human', is_bot: false } } });
  t('бот: не бот — отказ', (await notBot.m.addBot(TOKEN_B)).ok === false);
  t('бот: все записанные пути безопасны', e.db.writes.every((w) => Object.keys(w).every((k) => KEY_RE.test(k))));
}

// ---------- создание и правка рассылки ----------
{
  const e = makeEnv();
  e.db.root.chatAdmin = { _global: { chats: { [C1]: { title: 'Наш чат' } } } };
  let r = await e.m.save(input({ chats: [C1, '@my_channel'], senders: ['main', '999999999'] }));
  t('рассылка: бот, которого нет в списке — отказ', r.ok === false && r.text.includes('нет в списке'));
  r = await e.m.save(input({ chats: [C1, '@my_channel'] }));
  const c = e.db.root.mailer.campaigns[r.id];
  t('рассылка: создана на паузе, название чата берётся из включённых', r.ok && c.status === 'paused' && c.chats[C1].title === 'Наш чат', c);
  t('рассылка: @имя превращено в номер чата', c.chats['-1003333333333'] && c.chats['@my_channel'] === undefined, c.chats);
  t('рассылка: варианты, интервал, часы записаны', c.variants.v0.text.includes('{chat}') && c.variants.v1 && c.everyMin === 60 && c.hours.from === 9 && c.senders.main === true);
  await e.m.setStatus(r.id, 'active');
  e.db.root.mailer.campaigns[r.id].stats = { sent: 5 };
  e.db.root.mailer.campaigns[r.id].state = { [C1]: { at: 1 }, '-1003333333333': { at: 2 } };
  const r2 = await e.m.save(input({ name: 'Новое имя', chats: [C1], variants: [{ text: 'Только один' }] }), r.id);
  const c2 = e.db.root.mailer.campaigns[r.id];
  t('правка: статус и статистика сохранились, имя новое', r2.ok && c2.status === 'active' && c2.stats.sent === 5 && c2.name === 'Новое имя', c2);
  t('правка: убранный чат, вариант и его состояние стёрты', !c2.chats['-1003333333333'] && !c2.variants.v1 && !(c2.state || {})['-1003333333333'] && c2.state[C1].at === 1, c2);
  t('правка: чужой номер рассылки — отказ', (await e.m.save(input(), 'cabcdef123')).ok === false);
  t('рассылка: все записанные пути безопасны', e.db.writes.every((w) => Object.keys(w).every((k) => KEY_RE.test(k))), e.db.writes.flatMap((w) => Object.keys(w)).filter((k) => !KEY_RE.test(k)));
  t('рассылка: пауза и запуск', (await e.m.setStatus(r.id, 'paused')).ok && e.db.root.mailer.campaigns[r.id].status === 'paused' && (await e.m.setStatus('плохой', 'active')).ok === false);
  t('рассылка: удаление', (await e.m.remove(r.id)).ok && !e.db.root.mailer.campaigns[r.id]);
  for (let i = 0; i < LIMITS.maxCampaigns; i++) await e.m.save(input({ name: 'К' + i }));
  t('рассылка: больше 20 — отказ', (await e.m.save(input({ name: 'лишняя' }))).ok === false);
}

// ---------- рассылка по расписанию ----------
{
  const e = await withCampaign({ order: 'cycle' });
  t('tick: рассылка на паузе — ничего', (await e.m.tick()) === 0 && e.sends().length === 0);
  await e.m.setStatus(e.id, 'active');
  const n = await e.m.tick();
  t('tick: в каждый чат ушло по одному сообщению', n === 2 && e.sends().length === 2 && e.sends().map((c) => c.payload.chat_id).sort().join() === [Number(C1), Number(C2)].sort().join(), e.sends());
  t('tick: подстановки сделаны', e.sends()[0].payload.text.includes('11.11.2026') && !e.sends()[0].payload.text.includes('{'), e.sends()[0].payload.text);
  const st = e.db.root.mailer.campaigns[e.id];
  t('tick: состояние и счётчики записаны', st.stats.sent === 2 && st.state[C1].n === 1 && st.state[C1].vi === 1 && st.last.ok === true && e.db.root.mailer.chatLast[C1] === NOW0, st);
  const logs = Object.values(Object.values(e.db.root.mailer.log)[0]);
  t('журнал: 2 записи, текста сообщений в нём нет', logs.length === 2 && logs.every((l) => l.ok && !JSON.stringify(l).includes('Привет')), logs);
  t('tick: сразу же повторно — ничего (интервал, пауза чата)', (await e.m.tick()) === 0 && e.sends().length === 2);
  e.clock.t = NOW0 + 61 * 60000;
  await e.m.tick();
  t('tick: через час — вторая волна, по кругу пошёл второй вариант', e.sends().length === 4 && e.sends()[2].payload.text === 'Второй вариант', e.sends().map((c) => c.payload.text));
  t('tick: все записанные пути безопасны', e.db.writes.every((w) => Object.keys(w).every((k) => KEY_RE.test(k))), e.db.writes.flatMap((w) => Object.keys(w)).filter((k) => !KEY_RE.test(k)));
}
{
  // случайный порядок: подряд один и тот же текст не шлём
  const e = await withCampaign({ order: 'random', chats: [C1], everyMin: 10, perDay: 48, hours: { from: 0, to: 0 }, variants: [{ text: 'А' }, { text: 'Б' }, { text: 'В' }] });
  await e.m.setStatus(e.id, 'active');
  const seq = [];
  for (let i = 0; i < 12; i++) { e.clock.t = NOW0 + i * 11 * 60000; await e.m.tick(); seq.push(e.sends().at(-1).payload.text); }
  t('случайный порядок: два одинаковых подряд не бывает, и разные тексты встречаются', seq.every((x, i) => i === 0 || x !== seq[i - 1]) && new Set(seq).size >= 2, seq);
}
{
  // суточный предел, тихие часы, общая пауза между рассылками
  const e = await withCampaign({ chats: [C1], everyMin: 10, perDay: 2, hours: { from: 0, to: 0 } });
  await e.m.setStatus(e.id, 'active');
  for (let i = 0; i < 5; i++) { e.clock.t = NOW0 + i * 11 * 60000; await e.m.tick(); }
  t('предел в сутки: не больше perDay сообщений на чат', e.sends().length === 2, e.sends().length);
  e.clock.t = NOW0 + DAY_MS + 60000; await e.m.tick();
  t('предел в сутки: на следующий день снова можно', e.sends().length === 3);
  const night = await withCampaign({ chats: [C1] });
  await night.m.setStatus(night.id, 'active');
  night.clock.t = Date.parse('2026-11-11T22:30:00Z'); // 23:30 в Берлине
  t('тихие часы: ночью не отправляем', (await night.m.tick()) === 0);
  night.clock.t = Date.parse('2026-11-12T08:30:00Z');
  t('тихие часы: утром отправляем', (await night.m.tick()) === 1);
  const two = await withCampaign({ chats: [C1], hours: { from: 0, to: 0 } });
  const other = await two.m.save(input({ name: 'Вторая', chats: [C1], hours: { from: 0, to: 0 } }));
  await two.m.setStatus(two.id, 'active'); await two.m.setStatus(other.id, 'active');
  await two.m.tick();
  t('общая пауза: две рассылки в один чат в одну минуту — отправится одна', two.sends().length === 1, two.sends().length);
}
{
  // несколько ботов по очереди
  const e = makeEnv();
  await e.m.addBot(TOKEN_A); await e.m.addBot(TOKEN_B);
  const r = await e.m.save(input({ chats: [C1], senders: ['main', '111111111', '222222222'], everyMin: 10, perDay: 48, hours: { from: 0, to: 0 } }));
  await e.m.setStatus(r.id, 'active');
  for (let i = 0; i < 6; i++) { e.clock.t = NOW0 + i * 11 * 60000; await e.m.tick(); }
  const who = e.sends().map((c) => c.who);
  t('несколько ботов: пишут по очереди', who.slice(0, 3).sort().join() === ['111111111', '222222222', 'main'].sort().join() && who.slice(3, 6).join() === who.slice(0, 3).join(), who);
  t('несколько ботов: чужой бот отправляет со своим токеном', e.sends().filter((c) => c.who === '111111111').every((c) => c.token === TOKEN_A));
  const rm = await e.m.removeBot('111111111');
  t('удаление бота: токен стёрт, из рассылок убран', rm.ok && !e.db.root.mailer.bots['111111111'] && !e.db.root.mailer.campaigns[r.id].senders['111111111'] && e.db.root.mailer.campaigns[r.id].senders.main === true);
  t('удаление главного бота нельзя', (await e.m.removeBot('main')).ok === false);
}
{
  // сбои
  const e = await withCampaign({ chats: [C1], everyMin: 10, perDay: 48, hours: { from: 0, to: 0 } }, { sendResult: { 'main:sendMessage': { ok: false, description: 'Forbidden: bot was kicked from the supergroup chat' } } });
  await e.m.setStatus(e.id, 'active');
  for (let i = 0; i < 6; i++) { e.clock.t = NOW0 + i * 11 * 60000; await e.m.tick(); }
  t('сбой: после 3 отказов пара «бот — чат» выключена и больше не пробуется', e.db.root.mailer.pairs['main_' + C1].off === true && e.sends().length === 3, { n: e.sends().length, p: e.db.root.mailer.pairs });
  t('сбой: причина записана в рассылку и в журнал', e.db.root.mailer.campaigns[e.id].last.ok === false && e.db.root.mailer.campaigns[e.id].stats.failed === 3 && Object.values(Object.values(e.db.root.mailer.log)[0]).some((l) => l.ok === false && l.e.includes('kicked')));
  const w = await withCampaign({ chats: [C1], hours: { from: 0, to: 0 } }, { sendResult: { 'main:sendMessage': { ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } } } });
  await w.m.setStatus(w.id, 'active'); await w.m.tick();
  t('сбой 429: ждём указанное время, пару не выключаем', w.db.root.mailer.campaigns[w.id].state[C1].nextAt === NOW0 + 31000 && !w.db.root.mailer.pairs);
  w.clock.t = NOW0 + 10000; await w.m.tick();
  t('сбой 429: до конца ожидания не стучимся', w.sends().length === 1);
  const tr = await withCampaign({ chats: [C1], hours: { from: 0, to: 0 } }, { sendResult: { 'main:sendMessage': { ok: false, description: 'network timeout' } } });
  await tr.m.setStatus(tr.id, 'active'); await tr.m.tick();
  t('сбой сети: повтор через 5 минут', tr.db.root.mailer.campaigns[tr.id].state[C1].nextAt === NOW0 + 5 * 60000 && !tr.db.root.mailer.pairs);
}
{
  // успех сбрасывает отказы; «Отправить сейчас» и «Проверить»
  const e = await withCampaign({ chats: [C1], hours: { from: 0, to: 0 } });
  e.db.root.mailer.pairs = { ['main_' + C1]: { fails: 2, off: true } };
  const r = await e.m.sendNow(e.id, C1);
  t('«сейчас»: отправляет мимо расписания и мимо выключенной пары, пара снова рабочая', r.ok && e.sends().length === 1 && !(e.db.root.mailer.pairs || {})['main_' + C1], r);
  t('«сейчас»: чат не из рассылки — отказ', (await e.m.sendNow(e.id, '-1009999999999')).ok === false);
  const chk = await e.m.check(e.id);
  t('«проверить»: строка на каждую пару, все могут писать', chk.ok && chk.rows.length === 1 && chk.rows[0].ok === true && chk.text.includes('Все боты'), chk);
  const noMember = await withCampaign({ chats: [C1, C2], hours: { from: 0, to: 0 } }, { sendResult: { 'main:getChatMember': (p) => (p.chat_id === Number(C2) ? { ok: false, description: 'Bad Request: chat not found' } : { ok: true, result: { status: 'administrator' } }) } });
  const chk2 = await noMember.m.check(noMember.id);
  t('«проверить»: где бота нет — видно причину', chk2.rows.filter((x) => !x.ok).length === 1 && chk2.rows.find((x) => !x.ok).error.includes('chat not found') && chk2.text.includes('1 из 2'), chk2);
}
{
  // список для панели и журнал
  const e = await withCampaign({ chats: [C1] });
  e.db.root.chatAdmin = { _global: { chats: { [C1]: { title: 'Наш чат' }, '-1004444444444': { title: 'Другой' } } } };
  await e.m.setStatus(e.id, 'active'); await e.m.tick();
  const v = await e.m.view();
  t('список: рассылка, чаты для выбора, боты', v.ok && v.campaigns.length === 1 && v.campaigns[0].variants.length === 2 && v.campaigns[0].stats.sent === 1 && v.chats.length === 2 && v.bots[0].main, v);
  const lg = await e.m.recentLog(10);
  t('журнал: последние отправки без текста', lg.log.length === 1 && lg.log[0].ok && !JSON.stringify(lg).includes('Привет'), lg);
  // уборка старого журнала
  e.db.root.mailer.log['2026-10-01'] = { a: { at: 1, ok: true } };
  e.db.root.mailer.meta = {};
  await e.m.maybePrune();
  t('уборка: журнал старше 14 дней удалён', !e.db.root.mailer.log['2026-10-01'] && !!e.db.root.mailer.log['2026-11-11']);
}

console.log(bad ? 'FAILED ' + bad : 'ALL PASS');
process.exit(bad ? 1 : 0);
