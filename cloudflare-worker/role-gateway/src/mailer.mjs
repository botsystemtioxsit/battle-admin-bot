// Рассылки: регулярные сообщения в чаты и каналы от имени ботов владельца. Управляется из панели (вкладка «Чаты → Рассылки»),
// выполняется Worker'ом по cron раз в минуту (tick). Как и chat-admin.mjs, модуль ничего не знает про Worker: Telegram, база и шифрование
// приходят в `deps`, поэтому проверяется тестами на подставных данных (test/mailer.test.mjs).
//
// Кто отправляет. «Аккаунты» — это БОТЫ по токену (официальный способ Telegram): главный бот «Терминал» (id 'main') и добавленные
// владельцем. Токен кладётся в базу ТОЛЬКО зашифрованным (deps.seal) и наружу не отдаётся никогда — ни панели, ни в журнал. Личные аккаунты
// (по номеру телефона) не подключаются: Telegram блокирует такую автоматизацию, а для неё нужен постоянно работающий сервер.
// Бот может писать только туда, где он состоит (его добавил администратор чата) — это и есть согласие чата.
//
// Данные (основная база, узел mailer — правила базы закрывают его от чтения и записи клиентами, пишет только Worker):
//   bots/<id бота>                 {username, name, enc, addedAt}            — enc: токен, зашифрованный
//   campaigns/<id>                 {name, status:'active'|'paused', chats:{<чат>:{title}}, senders:{<id|main>:true}, variants:{v0:{text,btn?}},
//                                   order:'random'|'cycle', everyMin, hours:{from,to}, tz, perDay, createdAt, stats:{sent,failed}, last:{…},
//                                   state:{<чат>:{at,n,day,si,vi,lastV,nextAt}}}
//   pairs/<id бота>_<чат>          {fails, off?, err?}                       — здоровье пары «бот — чат»: 3 отказа подряд выключают пару
//   chatLast/<чат>                 мс последней нашей отправки (общая пауза между любыми рассылками в один чат)
//   log/<день>/<id>                {at, c, cn, chat, ct, s, ok, e?, v}       — без текста сообщений; хранится 14 дней
//   meta/prunedDay
// Предохранители от флуда (чтобы ботов не заблокировали, а чаты не заспамили): не чаще раза в 10 минут на чат в одной рассылке, пауза 5 минут
// между любыми рассылками в один чат, не больше perDay сообщений в сутки на чат (до 48), «тихие часы», автостоп пары после 3 отказов.

export const DAY_MS = 86_400_000;
export const LIMITS = Object.freeze({ minEveryMin: 10, maxEveryMin: 10_080, maxVariants: 20, maxText: 3500, maxChats: 30, maxSenders: 10, maxCampaigns: 20, perDayMax: 48, chatCooldownMin: 5, tickSends: 12, logKeepDays: 14, failsToOff: 3 });
const CONTROL_RE = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const CHAT_ID_RE = /^-?\d{5,20}$/;
const USERNAME_RE = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/;
const SENDER_RE = /^(main|\d{5,15})$/;
const ID_RE = /^c[a-z0-9]{6,20}$/;

export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const inc = (n = 1) => ({ '.sv': { increment: n } });
const eventId = (at) => String(at).padStart(13, '0') + '-' + Math.random().toString(36).slice(2, 6);
export function cleanLine(v, max = 80) { return String(v ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
// текст сообщения: переводы строк сохраняются, лишние пустые строки схлопываются
export function cleanBody(v, max = LIMITS.maxText) { return String(v ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max); }
export const chatKeyOf = (id) => { const k = String(id); return CHAT_ID_RE.test(k) ? k : null; };

// Час в часовом поясе кампании (0–23)
export function hourIn(ms, tz) {
  try { const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(ms)); return Number(h) % 24; } catch { return new Date(ms).getUTCHours(); }
}
export function inHours(ms, hours, tz) {
  if (!hours || hours.from === hours.to) return true;
  const h = hourIn(ms, tz);
  return hours.from < hours.to ? h >= hours.from && h < hours.to : h >= hours.from || h < hours.to;
}
export function renderText(text, ctx) {
  const date = (() => { try { return new Intl.DateTimeFormat('ru-RU', { timeZone: ctx.tz || 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ctx.at)); } catch { return dayKey(ctx.at); } })();
  return String(text).replace(/\{chat\}/g, ctx.title || 'чат').replace(/\{date\}/g, date).slice(0, 4000);
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const list = (v) => Object.keys(obj(v)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

// Проверка и очистка присланной панелью рассылки. Возвращает { ok, value } или { ok:false, text }.
export function sanitizeCampaign(input) {
  const i = obj(input);
  const name = cleanLine(i.name, 60);
  if (!name) return { ok: false, text: 'Дайте рассылке название.' };
  const variants = (Array.isArray(i.variants) ? i.variants : []).map((v) => {
    const text = cleanBody(obj(v).text);
    if (!text) return null;
    const out = { text };
    const b = obj(obj(v).btn);
    const bt = cleanLine(b.text, 40); const bu = String(b.url || '').trim();
    if (bt && /^https:\/\/[^\s]{3,300}$/.test(bu)) out.btn = { text: bt, url: bu };
    return out;
  }).filter(Boolean);
  if (!variants.length) return { ok: false, text: 'Нужен хотя бы один текст сообщения.' };
  if (variants.length > LIMITS.maxVariants) return { ok: false, text: 'Не больше ' + LIMITS.maxVariants + ' вариантов текста.' };
  const chats = [...new Set((Array.isArray(i.chats) ? i.chats : []).map((c) => String(obj(c).id ?? c).trim()).filter((c) => CHAT_ID_RE.test(c) || USERNAME_RE.test(c)))];
  if (!chats.length) return { ok: false, text: 'Выберите хотя бы один чат.' };
  if (chats.length > LIMITS.maxChats) return { ok: false, text: 'Не больше ' + LIMITS.maxChats + ' чатов в одной рассылке.' };
  const senders = [...new Set((Array.isArray(i.senders) ? i.senders : []).map(String).filter((s) => SENDER_RE.test(s)))];
  if (!senders.length) return { ok: false, text: 'Выберите, от какого бота отправлять.' };
  if (senders.length > LIMITS.maxSenders) return { ok: false, text: 'Не больше ' + LIMITS.maxSenders + ' ботов в одной рассылке.' };
  const everyMin = Math.round(Number(i.everyMin));
  if (!Number.isFinite(everyMin) || everyMin < LIMITS.minEveryMin || everyMin > LIMITS.maxEveryMin) return { ok: false, text: `Интервал — от ${LIMITS.minEveryMin} минут до 7 суток.` };
  const perDay = Math.round(Number(i.perDay ?? 6));
  if (!Number.isFinite(perDay) || perDay < 1 || perDay > LIMITS.perDayMax) return { ok: false, text: 'Сообщений в сутки на чат — от 1 до ' + LIMITS.perDayMax + '.' };
  const tz = cleanLine(i.tz || 'Europe/Berlin', 40);
  try { new Intl.DateTimeFormat('ru-RU', { timeZone: tz }); } catch { return { ok: false, text: 'Не знаю такой часовой пояс (пример: Europe/Berlin).' }; }
  const from = Math.round(Number(obj(i.hours).from ?? 0)); const to = Math.round(Number(obj(i.hours).to ?? 0));
  if (![from, to].every((h) => Number.isInteger(h) && h >= 0 && h <= 23)) return { ok: false, text: 'Часы отправки — числа от 0 до 23.' };
  return { ok: true, value: { name, variants, chats, senders, order: i.order === 'cycle' ? 'cycle' : 'random', everyMin, perDay, tz, hours: { from, to } } };
}

// Телеграм-ошибка → что делать дальше
export function classifyError(res) {
  const d = String((res && res.description) || '');
  const retry = res && res.parameters && Number(res.parameters.retry_after);
  if (retry > 0) return { kind: 'wait', waitMs: Math.min(retry, 3600) * 1000 + 1000, text: 'Telegram просит подождать ' + retry + ' с' };
  if (res && res.parameters && res.parameters.migrate_to_chat_id) return { kind: 'pair', text: 'Чат стал супергруппой — укажите его новый номер' };
  if (/chat not found|bot was kicked|bot is not a member|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|CHAT_SEND_PLAIN_FORBIDDEN|bot was blocked|forbidden|chat_write|need administrator rights/i.test(d)) return { kind: 'pair', text: cleanLine(d, 100) || 'бот не может писать в этот чат' };
  return { kind: 'transient', text: cleanLine(d, 100) || 'ошибка сети' };
}

// deps: { tg(method, payload) → главный бот; tgWithToken(token, method, payload); mainBot() → {id, username}; seal(text) → строка; unseal(строка) → текст;
//         dbGet(path, {shallow}); dbUpdate({путь: значение}); now() }
export function createMailer(deps) {
  const now = () => (deps.now ? deps.now() : Date.now());
  const newId = () => 'c' + now().toString(36) + Math.random().toString(36).slice(2, 6);
  let mainName = '';
  async function refreshMain() { try { mainName = cleanLine((await deps.mainBot()).username, 40); } catch { /* имя — только для подписи */ } }

  async function botsMap() { return obj(await deps.dbGet('mailer/bots').catch(() => null)); }
  // вызов Bot API от имени отправителя
  async function call(senderId, method, payload, bots) {
    if (senderId === 'main') return deps.tg(method, payload);
    const rec = obj(obj(bots || (await botsMap()))[senderId]);
    if (!rec.enc) return { ok: false, description: 'этот бот удалён из списка' };
    let token;
    try { token = await deps.unseal(rec.enc); } catch { return { ok: false, description: 'токен бота не расшифровался — добавьте бота заново' }; }
    return deps.tgWithToken(token, method, payload);
  }
  const senderBotId = async (senderId) => (senderId === 'main' ? String((await deps.mainBot()).id || '') : senderId);
  const senderLabel = (senderId, bots) => (senderId === 'main' ? '@' + (mainName || 'главный') : '@' + (obj(obj(bots)[senderId]).username || senderId));

  // ----- боты-отправители -----
  async function addBot(token) {
    const tk = String(token || '').trim();
    if (!TOKEN_RE.test(tk)) return { ok: false, text: 'Это не похоже на токен бота (из @BotFather: «123456:ABC…»).' };
    const me = await deps.tgWithToken(tk, 'getMe', {});
    if (!me || !me.ok || !me.result) return { ok: false, text: 'Telegram не принял этот токен: ' + cleanLine(me && me.description, 80) };
    const id = String(me.result.id);
    if (!me.result.is_bot) return { ok: false, text: 'Это не бот.' };
    if (id === String((await deps.mainBot()).id)) return { ok: false, text: 'Это главный бот «Терминал» — он уже в списке.' };
    const bots = await botsMap();
    if (bots[id]) return { ok: false, text: 'Этот бот уже добавлен (@' + cleanLine(obj(bots[id]).username, 40) + ').' };
    if (Object.keys(bots).length >= 20) return { ok: false, text: 'Больше 20 ботов не нужно.' };
    const enc = await deps.seal(tk);
    await deps.dbUpdate({ [`mailer/bots/${id}`]: { username: cleanLine(me.result.username, 40), name: cleanLine(me.result.first_name, 60), enc, addedAt: now() } });
    return { ok: true, text: 'Бот @' + cleanLine(me.result.username, 40) + ' добавлен. Токен сохранён зашифрованным и больше нигде не показывается.', bot: { id, username: cleanLine(me.result.username, 40) } };
  }
  async function removeBot(id) {
    if (!SENDER_RE.test(String(id)) || id === 'main') return { ok: false, text: 'Нельзя убрать главного бота.' };
    const w = { [`mailer/bots/${id}`]: null };
    const pairs = obj(await deps.dbGet('mailer/pairs').catch(() => null));
    for (const k of Object.keys(pairs)) if (k.startsWith(id + '_')) w[`mailer/pairs/${k}`] = null;
    const camps = obj(await deps.dbGet('mailer/campaigns').catch(() => null));
    for (const [cid, c] of Object.entries(camps)) if (ID_RE.test(cid) && obj(obj(c).senders)[id]) w[`mailer/campaigns/${cid}/senders/${id}`] = null;
    await deps.dbUpdate(w);
    return { ok: true, text: 'Бот убран из списка (токен удалён из базы). Из рассылок он тоже убран.' };
  }

  // ----- рассылки: чтение и редактирование -----
  async function resolveChats(ids, senders, prev) {
    const enabled = obj(await deps.dbGet('chatAdmin/_global/chats').catch(() => null));
    const out = {};
    for (const id of ids) {
      let key = id; let title = '';
      if (USERNAME_RE.test(id)) {
        const r = await call(senders[0], 'getChat', { chat_id: id });
        if (!r.ok || !r.result) return { ok: false, text: 'Не нашёл чат ' + id + ' (бот должен его видеть): ' + cleanLine(r && r.description, 80) };
        key = String(r.result.id); title = cleanLine(r.result.title, 80);
      } else {
        title = cleanLine(obj(obj(obj(prev).chats)[key]).title, 80) || cleanLine(obj(enabled[key]).title, 80);
        if (!title) { const r = await call(senders[0], 'getChat', { chat_id: Number(key) }); title = r.ok && r.result ? cleanLine(r.result.title, 80) : '(не проверен)'; }
      }
      if (!chatKeyOf(key)) return { ok: false, text: 'Неверный номер чата: ' + id };
      out[key] = { title: title || '(без названия)' };
    }
    return { ok: true, chats: out };
  }
  async function save(input, id) {
    const s = sanitizeCampaign(input);
    if (!s.ok) return s;
    await refreshMain();
    const camps = obj(await deps.dbGet('mailer/campaigns').catch(() => null));
    const cid = id && ID_RE.test(String(id)) ? String(id) : null;
    if (cid && !camps[cid]) return { ok: false, text: 'Такой рассылки нет.' };
    if (!cid && Object.keys(camps).length >= LIMITS.maxCampaigns) return { ok: false, text: 'Не больше ' + LIMITS.maxCampaigns + ' рассылок.' };
    const bots = await botsMap();
    const unknown = s.value.senders.filter((x) => x !== 'main' && !bots[x]);
    if (unknown.length) return { ok: false, text: 'Бота ' + unknown[0] + ' нет в списке — добавьте его.' };
    const prev = cid ? obj(camps[cid]) : {};
    const rc = await resolveChats(s.value.chats, s.value.senders, prev);
    if (!rc.ok) return rc;
    const target = cid || newId();
    const base = `mailer/campaigns/${target}`;
    const w = {
      [`${base}/name`]: s.value.name,
      [`${base}/status`]: cid ? (prev.status === 'active' ? 'active' : 'paused') : 'paused', // новая рассылка сама не стартует — её запускают кнопкой
      [`${base}/order`]: s.value.order, [`${base}/everyMin`]: s.value.everyMin, [`${base}/perDay`]: s.value.perDay, [`${base}/tz`]: s.value.tz, [`${base}/hours`]: s.value.hours,
      [`${base}/createdAt`]: prev.createdAt ? prev.createdAt : now(),
    };
    // вложенные узлы заменяются одним пакетом: убранные ключи — null, новые — значения (окна, где рассылка «пустая», нет)
    const nodes = [['chats', rc.chats], ['senders', Object.fromEntries(s.value.senders.map((x) => [x, true]))], ['variants', Object.fromEntries(s.value.variants.map((v, k) => ['v' + k, v]))]];
    for (const [node, fresh] of nodes) {
      for (const k of Object.keys(obj(prev[node]))) if (!(k in fresh)) { w[`${base}/${node}/${k}`] = null; if (node === 'chats') w[`${base}/state/${k}`] = null; }
      for (const [k, v] of Object.entries(fresh)) w[`${base}/${node}/${k}`] = v;
    }
    await deps.dbUpdate(w);
    return { ok: true, id: target, text: cid ? 'Рассылка сохранена.' : 'Рассылка создана — она на паузе. Нажмите «Проверить» (бот должен состоять в чатах), затем «Запустить».' };
  }
  async function setStatus(id, status) {
    if (!ID_RE.test(String(id)) || !['active', 'paused'].includes(status)) return { ok: false, text: 'Неверный запрос.' };
    const c = obj(await deps.dbGet(`mailer/campaigns/${id}`).catch(() => null));
    if (!c.name) return { ok: false, text: 'Такой рассылки нет.' };
    await deps.dbUpdate({ [`mailer/campaigns/${id}/status`]: status });
    return { ok: true, text: status === 'active' ? 'Рассылка запущена: первые сообщения уйдут в течение минуты.' : 'Рассылка на паузе.' };
  }
  async function remove(id) {
    if (!ID_RE.test(String(id))) return { ok: false, text: 'Неверный запрос.' };
    await deps.dbUpdate({ [`mailer/campaigns/${id}`]: null });
    return { ok: true, text: 'Рассылка удалена.' };
  }

  // ----- отправка одного сообщения -----
  const pickVariant = (c, st) => {
    const keys = list(c.variants);
    if (!keys.length) return null;
    if (c.order === 'cycle') { const i = (Number(st.vi) || 0) % keys.length; return { key: keys[i], next: (i + 1) % keys.length, index: i }; }
    let i = Math.floor(Math.random() * keys.length);
    if (keys.length > 1 && st.lastV === keys[i]) i = (i + 1 + Math.floor(Math.random() * (keys.length - 1))) % keys.length; // два раза подряд один и тот же текст не шлём
    return { key: keys[i], next: 0, index: i };
  };
  // Отправить одно сообщение рассылки в чат. Пишет состояние и журнал. Возвращает { ok, text }.
  async function deliver(cid, c, chatKey, st, bots, pairs) {
    const at = now();
    const senderIds = list(c.senders).filter((s) => (s === 'main' || obj(bots)[s]) && !obj(pairs[`${s}_${chatKey}`]).off);
    const base = `mailer/campaigns/${cid}`;
    const title = cleanLine(obj(obj(c.chats)[chatKey]).title, 80);
    if (!senderIds.length) return { ok: false, text: 'Нет бота, который может писать в этот чат (все отключены после отказов).', skip: true };
    const si = (Number(st.si) || 0) % senderIds.length;
    const sender = senderIds[si];
    const pv = pickVariant(c, st);
    if (!pv) return { ok: false, text: 'В рассылке нет текстов.', skip: true };
    const v = obj(c.variants[pv.key]);
    const payload = { chat_id: Number(chatKey), text: renderText(v.text, { title, at, tz: c.tz }) };
    if (v.btn && v.btn.url) payload.reply_markup = { inline_keyboard: [[{ text: v.btn.text, url: v.btn.url }]] };
    const res = await call(sender, 'sendMessage', payload, bots);
    const day = dayKey(at);
    const w = {};
    const stBase = `${base}/state/${chatKey}`;
    const pairKey = `mailer/pairs/${sender}_${chatKey}`;
    const logId = `mailer/log/${day}/${eventId(at)}`;
    const logRec = { at, c: cid, cn: cleanLine(c.name, 60), chat: chatKey, ct: title, s: senderLabel(sender, bots), v: pv.index };
    if (res && res.ok) {
      w[`${stBase}/at`] = at; w[`${stBase}/day`] = day; w[`${stBase}/n`] = (st.day === day ? Number(st.n) || 0 : 0) + 1;
      w[`${stBase}/si`] = (si + 1) % senderIds.length; w[`${stBase}/vi`] = pv.next; w[`${stBase}/lastV`] = pv.key; w[`${stBase}/nextAt`] = null;
      w[`${base}/stats/sent`] = inc(); w[`${base}/last`] = { at, chat: chatKey, ok: true };
      w[pairKey] = null; w[`mailer/chatLast/${chatKey}`] = at;
      w[logId] = { ...logRec, ok: true };
      await deps.dbUpdate(w).catch(() => {});
      return { ok: true, text: `Отправлено в «${title || chatKey}» от ${senderLabel(sender, bots)}.`, at };
    }
    const cls = classifyError(res);
    w[`${base}/stats/failed`] = inc(); w[`${base}/last`] = { at, chat: chatKey, ok: false, err: cls.text };
    w[logId] = { ...logRec, ok: false, e: cls.text };
    if (cls.kind === 'wait') w[`${stBase}/nextAt`] = at + cls.waitMs;
    else if (cls.kind === 'transient') w[`${stBase}/nextAt`] = at + 5 * 60_000;
    else {
      const fails = (Number(obj(pairs[`${sender}_${chatKey}`]).fails) || 0) + 1;
      w[pairKey] = { fails, err: cls.text, ...(fails >= LIMITS.failsToOff ? { off: true } : {}) };
      w[`${stBase}/si`] = (si + 1) % senderIds.length; w[`${stBase}/nextAt`] = at + 2 * 60_000;
    }
    await deps.dbUpdate(w).catch(() => {});
    return { ok: false, text: `Не отправилось в «${title || chatKey}» (${senderLabel(sender, bots)}): ${cls.text}`, kind: cls.kind };
  }

  // Раз в минуту. Возвращает, сколько сообщений отправлено.
  async function tick() {
    const camps = obj(await deps.dbGet('mailer/campaigns').catch(() => null));
    const active = Object.entries(camps).filter(([id, c]) => ID_RE.test(id) && obj(c).status === 'active');
    if (!active.length) return 0;
    await refreshMain();
    const [bots, pairs, chatLast] = await Promise.all([botsMap(), deps.dbGet('mailer/pairs').catch(() => null).then(obj), deps.dbGet('mailer/chatLast').catch(() => null).then(obj)]);
    const t = now();
    let budget = LIMITS.tickSends; let sent = 0;
    active.sort((a, b) => (obj(a[1]).createdAt || 0) - (obj(b[1]).createdAt || 0));
    for (const [cid, c] of active) {
      if (budget <= 0) break;
      if (!inHours(t, c.hours, c.tz || 'Europe/Berlin')) continue;
      for (const chatKey of list(c.chats)) {
        if (budget <= 0) break;
        if (!chatKeyOf(chatKey)) continue;
        const st = obj(obj(c.state)[chatKey]);
        if (st.nextAt && t < st.nextAt) continue;
        if ((Number(st.at) || 0) + (Number(c.everyMin) || LIMITS.minEveryMin) * 60_000 > t) continue;
        if ((st.day === dayKey(t) ? Number(st.n) || 0 : 0) >= (Number(c.perDay) || 6)) continue;
        if (t - (Number(chatLast[chatKey]) || 0) < LIMITS.chatCooldownMin * 60_000) continue;
        budget -= 1;
        const r = await deliver(cid, c, chatKey, st, bots, pairs);
        if (r.ok) { sent += 1; chatLast[chatKey] = t; }
        else if (r.skip) { /* нечем отправлять — повторим в следующий раз */ }
      }
    }
    await maybePrune().catch(() => {});
    return sent;
  }
  async function maybePrune() {
    const today = dayKey(now());
    const meta = obj(await deps.dbGet('mailer/meta').catch(() => null));
    if (meta.prunedDay === today) return;
    await deps.dbUpdate({ 'mailer/meta/prunedDay': today });
    const keys = obj(await deps.dbGet('mailer/log', { shallow: true }).catch(() => null));
    const cutoff = dayKey(now() - LIMITS.logKeepDays * DAY_MS);
    const del = {};
    for (const d of Object.keys(keys)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) del[`mailer/log/${d}`] = null;
    if (Object.keys(del).length) await deps.dbUpdate(del);
  }

  // «Отправить сейчас» — один раз, мимо расписания (проверка, что всё работает)
  async function sendNow(id, chatId) {
    if (!ID_RE.test(String(id))) return { ok: false, text: 'Неверный запрос.' };
    const c = obj(await deps.dbGet(`mailer/campaigns/${id}`).catch(() => null));
    if (!c.name) return { ok: false, text: 'Такой рассылки нет.' };
    await refreshMain();
    const chats = list(c.chats);
    const chatKey = chatId !== undefined && chatId !== null ? String(chatId) : chats[0];
    if (!chatKey || !obj(c.chats)[chatKey]) return { ok: false, text: 'Этого чата нет в рассылке.' };
    const [bots, pairs] = await Promise.all([botsMap(), deps.dbGet('mailer/pairs').catch(() => null).then(obj)]);
    const st = obj(obj(c.state)[chatKey]);
    const fresh = { ...pairs }; for (const s of list(c.senders)) delete fresh[`${s}_${chatKey}`]; // пробная отправка пробует всех ботов заново
    return deliver(id, c, chatKey, st, bots, fresh);
  }

  // «Проверить»: состоит ли каждый выбранный бот в каждом чате и может ли писать
  async function check(id) {
    if (!ID_RE.test(String(id))) return { ok: false, text: 'Неверный запрос.' };
    const c = obj(await deps.dbGet(`mailer/campaigns/${id}`).catch(() => null));
    if (!c.name) return { ok: false, text: 'Такой рассылки нет.' };
    await refreshMain();
    const bots = await botsMap();
    const rows = [];
    for (const s of list(c.senders)) {
      const botId = await senderBotId(s);
      for (const chatKey of list(c.chats).slice(0, 30)) {
        const r = await call(s, 'getChatMember', { chat_id: Number(chatKey), user_id: Number(botId) }, bots);
        const m = r && r.ok ? r.result : null;
        const status = m ? m.status : null;
        const can = !!m && (status === 'creator' || status === 'administrator' || status === 'member' || (status === 'restricted' && m.can_send_messages !== false));
        rows.push({ chat: chatKey, title: cleanLine(obj(obj(c.chats)[chatKey]).title, 80), sender: senderLabel(s, bots), ok: can, status, error: m ? null : cleanLine(r && r.description, 100) });
      }
    }
    const bad = rows.filter((r) => !r.ok).length;
    return { ok: true, rows, text: bad ? `Не везде получится писать: ${bad} из ${rows.length}.` : 'Все боты состоят в чатах и могут писать.' };
  }

  async function view() {
    const [bots, camps, pairs, enabled, main] = await Promise.all([botsMap(), deps.dbGet('mailer/campaigns').catch(() => null).then(obj), deps.dbGet('mailer/pairs').catch(() => null).then(obj),
      deps.dbGet('chatAdmin/_global/chats').catch(() => null).then(obj), deps.mainBot()]);
    const mainName = cleanLine(main && main.username, 40);
    const botList = [{ id: 'main', username: mainName, name: 'Главный бот «Терминал»', main: true, off: 0 }, ...Object.entries(bots).filter(([id]) => /^\d{5,15}$/.test(id)).map(([id, b]) => ({ id, username: cleanLine(obj(b).username, 40), name: cleanLine(obj(b).name, 60), off: Object.entries(pairs).filter(([k, p]) => k.startsWith(id + '_') && obj(p).off).length }))];
    const mainOff = Object.entries(pairs).filter(([k, p]) => k.startsWith('main_') && obj(p).off).length; botList[0].off = mainOff;
    const campaigns = Object.entries(camps).filter(([id]) => ID_RE.test(id)).map(([id, c0]) => {
      const c = obj(c0);
      return { id, name: cleanLine(c.name, 60), status: c.status === 'active' ? 'active' : 'paused', order: c.order === 'cycle' ? 'cycle' : 'random', everyMin: Number(c.everyMin) || 0, perDay: Number(c.perDay) || 0, tz: cleanLine(c.tz, 40), hours: { from: Number(obj(c.hours).from) || 0, to: Number(obj(c.hours).to) || 0 },
        senders: list(c.senders), variants: list(c.variants).map((k) => ({ text: cleanBody(obj(c.variants[k]).text), btn: obj(c.variants[k]).btn || null })),
        chats: list(c.chats).map((k) => { const st = obj(obj(c.state)[k]); return { id: k, title: cleanLine(obj(c.chats[k]).title, 80), at: Number(st.at) || 0, n: st.day === dayKey(now()) ? Number(st.n) || 0 : 0, off: list(c.senders).filter((s) => obj(pairs[`${s}_${k}`]).off).length }; }),
        stats: { sent: Number(obj(c.stats).sent) || 0, failed: Number(obj(c.stats).failed) || 0 }, last: c.last ? { at: Number(obj(c.last).at) || 0, ok: !!obj(c.last).ok, err: cleanLine(obj(c.last).err, 100), chat: cleanLine(obj(c.last).chat, 30) } : null, createdAt: Number(c.createdAt) || 0 };
    }).sort((a, b) => a.createdAt - b.createdAt);
    return { ok: true, bots: botList, campaigns, chats: Object.entries(enabled).filter(([k]) => chatKeyOf(k)).map(([k, v]) => ({ id: k, title: cleanLine(obj(v).title, 80) })), now: now() };
  }
  async function recentLog(limit = 40) {
    const days = Object.keys(obj(await deps.dbGet('mailer/log', { shallow: true }).catch(() => null))).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 3);
    const rows = [];
    for (const d of days) {
      const day = obj(await deps.dbGet(`mailer/log/${d}`).catch(() => null));
      for (const r of Object.values(day)) { const x = obj(r); rows.push({ at: Number(x.at) || 0, campaign: cleanLine(x.cn, 60), chat: cleanLine(x.ct || x.chat, 80), sender: cleanLine(x.s, 50), ok: !!x.ok, error: cleanLine(x.e, 100) }); }
      if (rows.length >= limit) break;
    }
    return { ok: true, log: rows.sort((a, b) => b.at - a.at).slice(0, limit) };
  }

  return { view, recentLog, addBot, removeBot, save, setStatus, remove, sendNow, check, tick, maybePrune };
}
