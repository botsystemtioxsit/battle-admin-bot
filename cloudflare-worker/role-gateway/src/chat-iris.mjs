// Функции в духе «Ириса» для админ-бота чатов: карма, антифлуд и антиспам, фильтр слов, ночной режим, досье на человека, мини-игры с валютой.
// Модуль не знает про Worker: всё нужное приходит в createIris(host) из chat-admin.mjs. Все пути в базе — только числовые id и фиксированные
// слова (проходят проверку CHAT_DB_PATH_RE в index.js); текст сообщений НЕ хранится (для флуда помнится только хеш в памяти, до минуты).

export const IRIS_CFG_DEFAULTS = Object.freeze({ karma: true, flood: false, floodMax: 6, noFwd: false, newbieLinks: false, games: false, night: '', words: '' });
export const IRIS_CFG_KEYS = Object.freeze({ karma: 'bool', flood: 'bool', floodMax: 'num', noFwd: 'bool', newbieLinks: 'bool', games: 'bool', night: 'text', words: 'text' });
export const IRIS_PUBLIC = ['karma', 'topkarma', 'daily', 'balance', 'topcoins', 'gift', 'flip'];
export const IRIS_ADMIN = ['whois', 'addword', 'delword', 'words', 'night'];
export const IRIS_COMMANDS = [...IRIS_PUBLIC, ...IRIS_ADMIN];

const CURRENCY = 'ирисок';
const KARMA_UP = /^(\+{1,3}|\+1|спасибо|спс|благодарю|благодарствую|респект|плюс|класс|круто|топ)(?=[\s!.,)]|$)/i;
const KARMA_DOWN = /^(-{1,3}|-1|минус|дизлайк)(?=[\s!.,)]|$)/i;
const NIGHT_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export const normalizeWords = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9*]+/g, ' ').trim();
export function wordList(raw) { return String(raw || '').split(',').map(normalizeWords).filter(Boolean); }
// слово «мат» — целое слово; «мат*» — любое слово, начинающееся с «мат»
export function hitsWord(text, words) {
  const norm = ' ' + normalizeWords(text).replace(/\*/g, '') + ' ';
  return words.find((w) => (w.endsWith('*') ? norm.includes(' ' + w.slice(0, -1)) : norm.includes(' ' + w + ' '))) || null;
}
export function parseNight(s) {
  const m = NIGHT_RE.exec(String(s || '').trim());
  return m ? { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]), text: s.trim() } : null;
}
export function inNight(win, minutes) {
  if (!win || win.from === win.to) return false;
  return win.from < win.to ? minutes >= win.from && minutes < win.to : minutes >= win.from || minutes < win.to;
}
export function minutesIn(tz, ms) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
    const h = Number(p.find((x) => x.type === 'hour').value) % 24; const m = Number(p.find((x) => x.type === 'minute').value);
    return h * 60 + m;
  } catch { return null; }
}

export function createIris(h) {
  const { deps, now, inc, cleanText, displayName } = h;
  const flood = new Map();   // chatKey:uid → { ts:[…], last, rep, repAt } — в памяти этого экземпляра Worker'а, не в базе
  const noticeAt = new Map();
  const cfgOf = (cfg) => ({ ...IRIS_CFG_DEFAULTS, ...(cfg || {}) });
  const handles = (name) => IRIS_COMMANDS.includes(name);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const base = (k) => `chatAdmin/${k}`;
  const hasUrl = (msg) => (msg.entities || msg.caption_entities || []).some((e) => e.type === 'url' || e.type === 'text_link');
  const isForward = (msg) => !!(msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_date);

  async function mute(chat, userId, seconds) {
    return deps.tg('restrictChatMember', { chat_id: chat.id, user_id: Number(userId), permissions: h.ALL_FALSE, until_date: Math.floor(now() / 1000) + seconds, use_independent_chat_permissions: false });
  }

  // ---------- обычные сообщения ----------
  // ctx: { chat, chatKey, cfg, msg, fromId, isAdmin(), tmp(text) } → true, если сообщение удалено/обработано здесь
  async function onText(ctx) {
    const { chat, chatKey, msg, fromId } = ctx;
    const cfg = cfgOf(ctx.cfg);
    const text = typeof msg.text === 'string' ? msg.text : typeof msg.caption === 'string' ? msg.caption : '';

    // карма: ответили на чужое сообщение «+», «спасибо», «-» …
    const rep = msg.reply_to_message;
    if (cfg.karma !== false && rep && rep.from && !rep.from.is_bot && !rep.sender_chat && String(rep.from.id) !== String(fromId) && text.length <= 40) {
      const t = text.trim();
      const delta = KARMA_UP.test(t) ? 1 : KARMA_DOWN.test(t) ? -1 : 0;
      if (delta) await giveKarma(ctx, rep.from, delta);
    }

    const words = wordList(cfg.words);
    if (!cfg.flood && !cfg.noFwd && !cfg.newbieLinks && !words.length) return false;
    if (await ctx.isAdmin()) return false;

    // пересылки
    if (cfg.noFwd && isForward(msg)) {
      await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id });
      if (now() - (noticeAt.get(chatKey + 'f') || 0) > 60_000) { noticeAt.set(chatKey + 'f', now()); await ctx.tmp('Пересылать сообщения в этом чате может только администратор.'); }
      return true;
    }
    // запрещённые слова: удалить и предупредить
    const bad = words.length && text ? hitsWord(text, words) : null;
    if (bad) {
      await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id });
      const r = await h.act(chat.id, 'warn', { id: String(fromId), name: displayName(msg.from) }, { reason: 'запрещённое слово' }, { id: null, name: 'Фильтр слов' });
      await ctx.tmp(r.text);
      return true;
    }
    // ссылки от новичков (первые сутки в чате)
    if (cfg.newbieLinks && hasUrl(msg)) {
      const joined = num(await deps.dbGet(`${base(chatKey)}/users/${fromId}/joinedAt`).catch(() => 0));
      if (joined && now() - joined < 86_400_000) {
        await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id });
        if (now() - (noticeAt.get(chatKey + 'n') || 0) > 60_000) { noticeAt.set(chatKey + 'n', now()); await ctx.tmp('Ссылки в первые сутки в чате отправлять нельзя.'); }
        return true;
      }
    }
    // флуд: слишком много сообщений за 10 секунд или один и тот же текст подряд
    if (cfg.flood) {
      const key = chatKey + ':' + fromId;
      const e = flood.get(key) || { ts: [], last: '', rep: 0, repAt: 0 };
      const t = now();
      e.ts = e.ts.filter((x) => t - x < 10_000); e.ts.push(t);
      const sig = normalizeWords(text).slice(0, 200);
      if (sig.length >= 6 && sig === e.last && t - e.repAt < 60_000) e.rep++; else { e.rep = 1; e.last = sig; }
      e.repAt = t;
      flood.set(key, e);
      if (flood.size > 5000) for (const k of [...flood.keys()].slice(0, 2500)) flood.delete(k);
      const max = Math.min(20, Math.max(3, Math.round(num(cfg.floodMax) || 6)));
      if (e.ts.length > max || e.rep >= 3) {
        flood.delete(key);
        await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id });
        const r = await mute(chat, fromId, 600);
        if (r && r.ok) {
          await h.logMod(chatKey, { id: null, name: 'Антифлуд' }, 'mute', { id: String(fromId), name: displayName(msg.from) }, e.rep >= 3 ? 'повторяет одно и то же · 10 мин' : 'слишком много сообщений · 10 мин');
          await ctx.tmp(`${displayName(msg.from)}: мут на 10 минут за флуд.`);
        }
        return true;
      }
    }
    return false;
  }

  // ---------- карма ----------
  async function giveKarma(ctx, target, delta) {
    const { chatKey, fromId, msg } = ctx;
    const g = await deps.dbGet(`${base(chatKey)}/users/${fromId}`).catch(() => null);
    const me = g && typeof g === 'object' ? g : {};
    if (now() - num(me.karmaAt) < 30_000) return; // не чаще раза в 30 секунд
    if (now() - num((me.karmaTo || {})[target.id]) < 3_600_000) { await ctx.tmp('Этому человеку вы уже меняли карму меньше часа назад.'); return; }
    const cur = num(await deps.dbGet(`${base(chatKey)}/karma/${target.id}/n`).catch(() => 0));
    const next = cur + delta;
    await deps.dbUpdate({
      [`${base(chatKey)}/karma/${target.id}/n`]: next, [`${base(chatKey)}/karma/${target.id}/name`]: cleanText(displayName(target), 60),
      [`${base(chatKey)}/users/${fromId}/karmaAt`]: now(), [`${base(chatKey)}/users/${fromId}/karmaTo/${target.id}`]: now(),
    });
    await ctx.tmp(`Карма ${displayName(target)}: ${next} (${delta > 0 ? '+1' : '-1'} от ${displayName(msg.from)})`);
  }

  // ---------- команды ----------
  // ctx: { chat, chatKey, meta, cfg, msg, cmd, fromId, isAdmin(), tmp(text), say(text), setCfg(key, value), actor }
  async function onCommand(ctx) {
    const { chat, chatKey, msg, cmd, fromId } = ctx;
    const cfg = cfgOf(ctx.cfg);
    const name = cmd.name;
    const target = async () => (await h.resolveTarget(msg, cmd.args)) || { id: String(fromId), name: displayName(msg.from), rest: cmd.args };

    if (IRIS_ADMIN.includes(name) && !(await ctx.isAdmin())) { await ctx.tmp('Эта команда — для администраторов чата.'); return true; }

    if (name === 'karma') {
      const t = await target();
      const k = await deps.dbGet(`${base(chatKey)}/karma/${t.id}/n`).catch(() => 0);
      await ctx.say(`Карма ${t.name}: ${num(k)}`);
      return true;
    }
    if (name === 'topkarma') {
      const all = await deps.dbGet(`${base(chatKey)}/karma`).catch(() => null);
      const rows = Object.entries(all && typeof all === 'object' ? all : {}).filter(([id, v]) => /^\d{1,15}$/.test(id) && v && typeof v === 'object')
        .map(([id, v]) => [cleanText(v.name || id, 40), num(v.n)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
      await ctx.say(rows.length ? 'Лучшая карма в чате\n' + rows.map(([n, k], i) => `${i + 1}. ${n} — ${k}`).join('\n') : 'Кармы пока ни у кого нет: ответьте на сообщение словом «спасибо» или «+».');
      return true;
    }
    if (name === 'whois') {
      const t = await h.resolveTarget(msg, cmd.args);
      if (!t) { await ctx.tmp('Ответьте командой на сообщение человека или укажите его числовой id.'); return true; }
      const [u, k, c] = await Promise.all([deps.dbGet(`${base(chatKey)}/users/${t.id}`).catch(() => null), deps.dbGet(`${base(chatKey)}/karma/${t.id}/n`).catch(() => 0), deps.dbGet(`${base(chatKey)}/coins/${t.id}/n`).catch(() => 0)]);
      const r = u && typeof u === 'object' ? u : {};
      const when = (ms) => (num(ms) ? new Date(num(ms)).toLocaleString('ru-RU', { timeZone: cfg.tz || 'Europe/Berlin' }) : 'нет данных');
      const st = await deps.tg('getChatMember', { chat_id: chat.id, user_id: Number(t.id) }).catch(() => null);
      const lines = [
        `Досье: ${cleanText(r.name || t.name, 60)}${r.username ? ' (@' + cleanText(r.username, 40) + ')' : ''}`, `id ${t.id}`,
        `Сейчас в чате: ${st && st.ok && st.result ? st.result.status : 'неизвестно'}`,
        `Вошёл: ${when(r.joinedAt)}${r.how && h.HOW_LABELS[r.how] ? ' · ' + h.HOW_LABELS[r.how] : ''}`,
        `Писал в последний раз: ${when(r.lastSeen)}`, `Сообщений: ${num(r.messages)} · предупреждений: ${num(r.warns)} · карма: ${num(k)}${cfg.games ? ' · ' + CURRENCY + ': ' + num(c) : ''}`,
        r.verifiedAt ? `Проверку «я не бот» прошёл: ${when(r.verifiedAt)}` : 'Проверку «я не бот» не проходил',
      ];
      await ctx.say(lines.join('\n'));
      return true;
    }
    if (name === 'words' || name === 'addword' || name === 'delword') {
      const list = wordList(cfg.words);
      if (name === 'words') { await ctx.say(list.length ? 'Запрещённые слова: ' + list.join(', ') + '\nОкончание «*» — любое слово с таким началом.' : 'Список запрещённых слов пуст. Добавить: /addword слово (или слово* для всех слов с таким началом).'); return true; }
      const w = normalizeWords(cmd.args).split(' ').filter(Boolean);
      if (!w.length) { await ctx.tmp('Напишите слово после команды.'); return true; }
      const next = name === 'addword' ? [...new Set([...list, ...w])] : list.filter((x) => !w.includes(x));
      if (next.join(',').length > 1500) { await ctx.tmp('Список слов слишком длинный.'); return true; }
      await ctx.setCfg('words', next.join(','));
      await ctx.tmp(name === 'addword' ? `Добавлено. Слов в списке: ${next.length}. Включено: фильтр действует всегда, пока список не пуст.` : `Убрано. Слов в списке: ${next.length}.`);
      return true;
    }
    if (name === 'night') {
      const a = cmd.args.trim().toLowerCase();
      if (!a) { await ctx.say(cfg.night ? `Ночной режим: чат закрыт с ${cfg.night.slice(0, 5)} до ${cfg.night.slice(6)} (${cfg.tz}). Выключить: /night off` : 'Ночной режим выключен. Включить: /night 23:00-07:00 (время по часовому поясу чата, его меняет /set tz).'); return true; }
      if (a === 'off' || a === 'выкл') { await ctx.setCfg('night', ''); await nightTick(chatKey, chat, { ...ctx.meta, cfg: { ...(ctx.meta.cfg || {}), night: '' } }); await ctx.tmp('Ночной режим выключен.'); return true; }
      if (!parseNight(a)) { await ctx.tmp('Нужно время вида /night 23:00-07:00 или /night off.'); return true; }
      await ctx.setCfg('night', a);
      await ctx.tmp(`Ночной режим: с ${a.slice(0, 5)} до ${a.slice(6)} чат закрыт для обычных участников, утром откроется сам.`);
      return true;
    }

    // игры и валюта — включает админ: /set games on
    if (!cfg.games) { await ctx.tmp('Игры выключены. Администратор может включить: /set games on'); return true; }
    const coinsOf = async (id) => num(await deps.dbGet(`${base(chatKey)}/coins/${id}/n`).catch(() => 0));
    const mine = String(fromId);
    if (name === 'balance') { const t = await target(); await ctx.say(`${t.name}: ${await coinsOf(t.id)} ${CURRENCY}`); return true; }
    if (name === 'topcoins') {
      const all = await deps.dbGet(`${base(chatKey)}/coins`).catch(() => null);
      const rows = Object.entries(all && typeof all === 'object' ? all : {}).filter(([id, v]) => /^\d{1,15}$/.test(id) && v && typeof v === 'object').map(([id, v]) => [cleanText(v.name || id, 40), num(v.n)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
      await ctx.say(rows.length ? 'Богатейшие в чате\n' + rows.map(([n, v], i) => `${i + 1}. ${n} — ${v}`).join('\n') : 'Пока ни у кого нет ' + CURRENCY + '. Получить: /daily');
      return true;
    }
    const who = cleanText(displayName(msg.from), 60);
    if (name === 'daily') {
      const day = h.dayKey(now());
      const d = await deps.dbGet(`${base(chatKey)}/coins/${mine}/day`).catch(() => null);
      if (d === day) { await ctx.tmp('Сегодняшний подарок вы уже забрали. Приходите завтра.'); return true; }
      const gain = 20 + Math.floor(Math.random() * 41);
      await deps.dbUpdate({ [`${base(chatKey)}/coins/${mine}/n`]: inc(gain), [`${base(chatKey)}/coins/${mine}/day`]: day, [`${base(chatKey)}/coins/${mine}/name`]: who });
      await ctx.tmp(`${who}: +${gain} ${CURRENCY}. Баланс: ${(await coinsOf(mine))}`);
      return true;
    }
    if (name === 'gift') {
      const t = await h.resolveTarget(msg, cmd.args);
      const amount = Math.floor(num((t ? t.rest : cmd.args).trim().split(/\s+/)[0]));
      if (!t || t.id === mine || (t.user && t.user.is_bot)) { await ctx.tmp('Ответьте командой на сообщение другого человека: /gift 50'); return true; }
      if (amount < 1 || amount > 1000) { await ctx.tmp('Сумма от 1 до 1000: /gift 50'); return true; }
      if ((await coinsOf(mine)) < amount) { await ctx.tmp('Не хватает ' + CURRENCY + '.'); return true; }
      await deps.dbUpdate({ [`${base(chatKey)}/coins/${mine}/n`]: inc(-amount), [`${base(chatKey)}/coins/${t.id}/n`]: inc(amount), [`${base(chatKey)}/coins/${t.id}/name`]: cleanText(t.name, 60) });
      await ctx.tmp(`${who} подарил ${t.name}: ${amount} ${CURRENCY}.`);
      return true;
    }
    if (name === 'flip') {
      const stake = Math.floor(num(cmd.args.trim().split(/\s+/)[0]));
      if (stake < 1 || stake > 100) { await ctx.tmp('Ставка от 1 до 100: /flip 10'); return true; }
      const lastAt = num(await deps.dbGet(`${base(chatKey)}/coins/${mine}/flipAt`).catch(() => 0));
      if (now() - lastAt < 10_000) { await ctx.tmp('Не так быстро: подождите несколько секунд.'); return true; }
      if ((await coinsOf(mine)) < stake) { await ctx.tmp('Не хватает ' + CURRENCY + ': сначала /daily'); return true; }
      const win = Math.random() < 0.5;
      await deps.dbUpdate({ [`${base(chatKey)}/coins/${mine}/n`]: inc(win ? stake : -stake), [`${base(chatKey)}/coins/${mine}/flipAt`]: now(), [`${base(chatKey)}/coins/${mine}/name`]: who });
      await ctx.tmp(`${who}: ${win ? 'выиграл' : 'проиграл'} ${stake} ${CURRENCY}. Баланс: ${await coinsOf(mine)}`);
      return true;
    }
    return false;
  }

  // ---------- ночной режим: вызывается из cron раз в минуту ----------
  async function nightTick(chatKey, chat, meta) {
    const cfg = cfgOf(meta && meta.cfg);
    const win = parseNight(cfg.night);
    const state = meta && meta.nightState;
    const chatId = chat && chat.id !== undefined ? chat.id : Number(chatKey);
    const say = (text) => deps.tg('sendMessage', { chat_id: chatId, text });
    const mins = minutesIn(cfg.tz || 'Europe/Berlin', now());
    const shouldClose = !!win && mins !== null && inNight(win, mins);
    if (shouldClose && state !== 'closed') {
      const c = await deps.tg('getChat', { chat_id: chatId }).catch(() => null);
      const perms = c && c.ok && c.result && c.result.permissions ? c.result.permissions : null;
      if (!perms) return false; // не знаем прежних прав — не закрываем, чтобы потом не открыть неправильно
      const r = await deps.tg('setChatPermissions', { chat_id: chatId, permissions: h.ALL_FALSE, use_independent_chat_permissions: false });
      if (!r || !r.ok) return false;
      await deps.dbUpdate({ [`${base(chatKey)}/meta/nightState`]: 'closed', [`${base(chatKey)}/meta/nightPerms`]: JSON.stringify(perms) });
      h.forgetMeta(chatKey);
      await say(`Ночной режим: чат закрыт до ${cfg.night.slice(6)}. Администраторы писать могут.`);
      return true;
    }
    if (!shouldClose && state === 'closed') {
      let perms = null;
      try { const p = JSON.parse(meta.nightPerms || 'null'); if (p && typeof p === 'object') { perms = {}; for (const k of Object.keys(h.ALL_FALSE)) perms[k] = !!p[k]; } } catch { perms = null; }
      if (!perms) perms = await h.defaultPerms(chatId);
      const r = await deps.tg('setChatPermissions', { chat_id: chatId, permissions: perms, use_independent_chat_permissions: false });
      if (!r || !r.ok) return false;
      await deps.dbUpdate({ [`${base(chatKey)}/meta/nightState`]: 'open', [`${base(chatKey)}/meta/nightPerms`]: null });
      h.forgetMeta(chatKey);
      await say('Доброе утро! Чат снова открыт.');
      return true;
    }
    return false;
  }

  return { handles, onText, onCommand, nightTick, cfgOf };
}
