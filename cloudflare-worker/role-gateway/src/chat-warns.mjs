// Система предупреждений администрации (Warn System): старшие администраторы выдают предупреждения другим администраторам чата.
// Отдельный модуль, как chat-iris.mjs: ничего не знает про Worker, всё приходит в createWarns(host).
//
// Данные (закрытый узел chatAdmin, пишет только Worker):
//   chatAdmin/<чат>/wn/w<N>      — предупреждение {n, to, toName, by, byName, reason, at, until, status: active|cancelled|expired, ...}
//   chatAdmin/<чат>/wnSeniors/<id> — старшие администраторы {name, by, at}
//   chatAdmin/<чат>/wnlog/<id>   — журнал действий системы (ничего не стирается, даже при удалении предупреждения)
//   chatAdmin/_global/wnPending/<чат>_w<N> = until (мс) — очередь «срок истечёт»: по ней cron раз в минуту находит истёкшие
// Время — только UTC (миллисекунды); срок = выдача + 20 суток ровно.

export const WARN_DAYS = 20;
export const WARN_THRESHOLD = 3;
export const WARN_COMMANDS = Object.freeze(['awarn', 'awarns', 'awhistory', 'awcancel', 'awdel', 'awlog', 'senior']);
const DAY_MS = 86_400_000;

export const isActiveWarn = (w, nowMs) => !!w && w.status === 'active' && Number(w.until) > nowMs;
export function warnStatus(w, nowMs) {
  if (!w) return '—';
  if (w.status === 'cancelled') return 'отменено';
  if (w.status === 'expired' || Number(w.until) <= nowMs) return 'истекло';
  return 'активно';
}
export function fmtUtc(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function createWarns(host) {
  const { deps, now, say, cleanText, displayName, userKeyOf, eventId, owners, memberStatus, isChatAdmin, resolveTarget, chatKeyOf } = host;
  const handles = (name) => WARN_COMMANDS.includes(name);

  const readWarns = async (chatKey) => {
    const o = await deps.dbGet(`chatAdmin/${chatKey}/wn`).catch(() => null);
    const list = [];
    for (const [k, w] of Object.entries(o && typeof o === 'object' ? o : {})) {
      if (/^w\d{1,9}$/.test(k) && w && typeof w === 'object' && userKeyOf(w.to)) list.push({ ...w, key: k, n: Number(k.slice(1)) });
    }
    return list.sort((a, b) => a.n - b.n);
  };
  const readSeniors = async (chatKey) => {
    const o = await deps.dbGet(`chatAdmin/${chatKey}/wnSeniors`).catch(() => null);
    return o && typeof o === 'object' ? Object.keys(o).filter((k) => userKeyOf(k)) : [];
  };
  const isLeadership = async (chatId, uid) => owners.has(String(uid)) || (await memberStatus(chatId, uid)) === 'creator';
  const isSenior = async (chatId, chatKey, uid) => (await isLeadership(chatId, uid)) || (await readSeniors(chatKey)).includes(String(uid));

  async function logWn(chatKey, entry) {
    const at = now();
    await deps.dbUpdate({ [`chatAdmin/${chatKey}/wnlog/${eventId(at)}`]: { at, ...entry } }).catch(() => {});
  }
  // Личное сообщение (если человек ни разу не открывал бота, Telegram не даст написать — тогда false)
  async function dm(uid, text) {
    if (!userKeyOf(uid)) return false;
    try { const r = await deps.tg('sendMessage', { chat_id: Number(uid), text: String(text).slice(0, 4000) }); return !!(r && r.ok); } catch { return false; }
  }
  // Сообщение в чат с упоминанием человека (он получит уведомление)
  const mentionSay = (chatId, user, text) => {
    const name = cleanText(user.name, 60);
    return deps.tg('sendMessage', { chat_id: chatId, text: String(name + ' ' + text).slice(0, 4000), entities: [{ type: 'text_mention', offset: 0, length: name.length, user: { id: Number(user.id) } }] });
  };
  const levelText = (n) => (n >= WARN_THRESHOLD ? 'критический порог' : n === 2 ? 'повторное нарушение' : n === 1 ? 'первое нарушение' : 'нет действующих');

  async function leadershipIds(chatId, chatKey) {
    const ids = new Set([...owners].map(String));
    const adm = await deps.tg('getChatAdministrators', { chat_id: chatId }).catch(() => null);
    for (const m of (adm && adm.ok && Array.isArray(adm.result) ? adm.result : [])) if (m.status === 'creator' && m.user && !m.user.is_bot) ids.add(String(m.user.id));
    for (const s of await readSeniors(chatKey)) ids.add(s);
    return [...ids];
  }

  function listText(title, list, nowMs, showWho) {
    if (!list.length) return title + '\nПусто.';
    const lines = [title];
    for (const w of list.slice(0, 25)) {
      lines.push(`№${w.n} · ${showWho ? cleanText(w.toName, 40) + ' (' + w.to + ') · ' : ''}${warnStatus(w, nowMs)}\n   причина: ${cleanText(w.reason, 200)}\n   выдал: ${cleanText(w.byName, 40)} · ${fmtUtc(w.at)}\n   действует до: ${fmtUtc(w.until)}`
        + (w.status === 'cancelled' ? `\n   отменил: ${cleanText(w.cancelByName, 40)} · ${fmtUtc(w.cancelAt)} · ${cleanText(w.cancelReason || 'без причины', 120)}` : ''));
    }
    if (list.length > 25) lines.push(`… и ещё ${list.length - 25}`);
    return lines.join('\n');
  }

  async function onCommand(ctx) {
    const { chat, chatKey, msg, cmd, fromId, tmp } = ctx;
    const actor = { id: String(fromId), name: displayName(msg.from) };
    const t0 = now();
    const name = cmd.name;
    if (!(await isChatAdmin(chat.id, fromId))) { await tmp('Эта команда — для администраторов чата.'); return true; }
    const senior = await isSenior(chat.id, chatKey, fromId);

    // ----- выдача -----
    if (name === 'awarn') {
      if (!senior) { await tmp('Выдавать предупреждения администраторам могут только старшие администраторы.'); return true; }
      const tg = await resolveTarget(msg, cmd.args);
      if (!tg) { await tmp('Ответьте на сообщение администратора командой /awarn причина (или укажите его числовой id: /awarn 123456789 причина).'); return true; }
      const reason = cleanText(tg.rest, 300);
      if (reason.length < 3) { await tmp('Укажите причину предупреждения: /awarn причина.'); return true; }
      if (String(tg.id) === String(fromId)) { await tmp('Себе предупреждение выдать нельзя.'); return true; }
      if (String(tg.id) === String(deps.botId)) { await tmp('Боту предупреждение выдать нельзя.'); return true; }
      if (await isLeadership(chat.id, tg.id)) { await tmp('Руководству предупреждения этой системой не выдаются.'); return true; }
      if (!(await isChatAdmin(chat.id, tg.id))) { await tmp('Предупреждения выдаются только администраторам чата. Этот человек не администратор.'); return true; }
      const all = await readWarns(chatKey);
      const n = (all.length ? all[all.length - 1].n : 0) + 1;
      const key = 'w' + n;
      const until = t0 + WARN_DAYS * DAY_MS;
      const toName = tg.user ? displayName(tg.user) : cleanText(tg.name, 60);
      const rec = { to: String(tg.id), toName, by: actor.id, byName: actor.name, reason, at: t0, until, status: 'active' };
      await deps.dbUpdate({ [`chatAdmin/${chatKey}/wn/${key}`]: rec, [`chatAdmin/_global/wnPending/${chatKey}_${key}`]: until });
      await logWn(chatKey, { t: 'issue', n, actor: actor.id, actorName: actor.name, to: rec.to, toName, reason, until });
      const active = all.filter((w) => w.to === rec.to && isActiveWarn(w, t0)).length + 1;
      const total = all.filter((w) => w.to === rec.to).length + 1;
      const dmOk = await dm(rec.to, `⚠️ Вам выдано предупреждение №${n} (чат «${cleanText(chat.title, 60)}»).\nПричина: ${reason}\nВыдал: ${actor.name}\nДата: ${fmtUtc(t0)}\nДействует до: ${fmtUtc(until)}\nДействующих предупреждений: ${active} (${levelText(active)}).`);
      await mentionSay(chat.id, { id: rec.to, name: toName }, `— предупреждение №${n}. Причина: ${reason}\nВыдал: ${actor.name}. Действует до ${fmtUtc(until)}. Действующих: ${active} из ${total} выданных (${levelText(active)}).` + (dmOk ? '' : '\n(В личные сообщения написать не удалось — откройте бота и нажмите Start.)'));
      if (active >= WARN_THRESHOLD) {
        await logWn(chatKey, { t: 'threshold', n, to: rec.to, toName, details: `действующих: ${active}` });
        const text = `🚨 У администратора ${toName} (${rec.to}) действующих предупреждений: ${active} — достигнут критический порог (${WARN_THRESHOLD}).\nЧат: «${cleanText(chat.title, 60)}». Бот ничего не ограничивает: решение — за руководством.\nИстория: /awhistory ${rec.to}`;
        const sent = [];
        for (const id of await leadershipIds(chat.id, chatKey)) if (id !== rec.to) sent.push(await dm(id, text));
        await dm(rec.to, `🚨 У вас действующих предупреждений: ${active} — достигнут критический порог. Руководство администрации уведомлено, решение за ним.`);
        await say(chat.id, `🚨 ${toName}: достигнут порог ${WARN_THRESHOLD} действующих предупреждений. Руководство уведомлено${sent.some(Boolean) ? '' : ' (личные сообщения могли не дойти — руководство, откройте бота и нажмите Start)'}. Решение остаётся за руководством.`);
      }
      return true;
    }

    // ----- просмотр -----
    if (name === 'awarns' || name === 'awhistory') {
      let tg = await resolveTarget(msg, cmd.args);
      if (!tg && cmd.args && /^\S+$/.test(cmd.args)) tg = null;
      const targetId = senior ? (tg ? tg.id : null) : String(fromId); // не старший видит только свои
      if (!senior && tg && String(tg.id) !== String(fromId)) { await tmp('Чужие предупреждения видят только старшие администраторы.'); return true; }
      const all = await readWarns(chatKey);
      const mine = targetId ? all.filter((w) => w.to === String(targetId)) : all;
      if (name === 'awarns') {
        const act = mine.filter((w) => isActiveWarn(w, t0));
        if (targetId) {
          const who = mine.length ? cleanText(mine[0].toName, 40) : targetId;
          await say(chat.id, listText(`⚠️ Действующие предупреждения: ${who} (${targetId}) — ${act.length} из ${mine.length} выданных (${levelText(act.length)})`, act, t0, false));
        } else {
          const byAdmin = new Map();
          for (const w of act) byAdmin.set(w.to, [...(byAdmin.get(w.to) || []), w]);
          const lines = [`⚠️ Действующие предупреждения администрации: ${act.length}`];
          for (const [id, ws] of byAdmin) lines.push(`• ${cleanText(ws[0].toName, 40)} (${id}) — ${ws.length} (${levelText(ws.length)}); ближайшее истекает ${fmtUtc(Math.min(...ws.map((x) => x.until)))}`);
          if (!byAdmin.size) lines.push('Ни у кого нет.');
          lines.push('Подробно по человеку: /awarns <id> или ответом на его сообщение.');
          await say(chat.id, lines.join('\n'));
        }
      } else {
        const act = mine.filter((w) => isActiveWarn(w, t0)).length;
        const head = targetId
          ? `📋 История предупреждений: ${mine.length ? cleanText(mine[0].toName, 40) : targetId} (${targetId})\nВсего выдано: ${mine.length} · действующих: ${act}`
          : `📋 История предупреждений администрации\nВсего выдано: ${mine.length} · действующих: ${act}`;
        await say(chat.id, listText(head, [...mine].reverse(), t0, !targetId));
      }
      return true;
    }

    // ----- журнал (старшие) -----
    if (name === 'awlog') {
      if (!senior) { await tmp('Журнал — для старших администраторов.'); return true; }
      const o = await deps.dbGet(`chatAdmin/${chatKey}/wnlog`).catch(() => null);
      const rows = Object.values(o && typeof o === 'object' ? o : {}).filter((e) => e && typeof e === 'object').sort((a, b) => b.at - a.at).slice(0, 15);
      const LAB = { issue: 'выдано', cancel: 'отменено', delete: 'удалено', expire: 'истекло', threshold: 'порог', senior_add: 'старший назначен', senior_del: 'старший снят' };
      await say(chat.id, rows.length ? '📒 Журнал предупреждений (последние ' + rows.length + ')\n' + rows.map((e) => `${fmtUtc(e.at)} · ${LAB[e.t] || e.t}${e.n ? ' №' + e.n : ''} · ${cleanText(e.toName || '', 30)}${e.actorName ? ' · кто: ' + cleanText(e.actorName, 30) : ''}${e.reason ? ' · ' + cleanText(e.reason, 80) : ''}${e.details ? ' · ' + cleanText(e.details, 80) : ''}`).join('\n') : 'Журнал пуст.');
      return true;
    }

    // ----- отмена и удаление (только руководство) -----
    if (name === 'awcancel' || name === 'awdel') {
      if (!(await isLeadership(chat.id, fromId))) { await tmp('Отменять и удалять предупреждения может только руководство (создатель чата и владелец проекта).'); return true; }
      const m = /^№?(\d{1,9})\b\s*([\s\S]*)$/.exec(cmd.args);
      if (!m) { await tmp(`Укажите номер: /${name} 5 причина`); return true; }
      const n = Number(m[1]);
      const reason = cleanText(m[2], 200);
      if (name === 'awcancel' && reason.length < 3) { await tmp('Укажите причину отмены: /awcancel 5 причина.'); return true; }
      const key = 'w' + n;
      const w = await deps.dbGet(`chatAdmin/${chatKey}/wn/${key}`).catch(() => null);
      if (!w || typeof w !== 'object') { await tmp(`Предупреждения №${n} нет.`); return true; }
      if (name === 'awcancel') {
        if (w.status === 'cancelled') { await tmp(`Предупреждение №${n} уже отменено.`); return true; }
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/wn/${key}/status`]: 'cancelled', [`chatAdmin/${chatKey}/wn/${key}/cancelAt`]: t0, [`chatAdmin/${chatKey}/wn/${key}/cancelBy`]: actor.id, [`chatAdmin/${chatKey}/wn/${key}/cancelByName`]: actor.name, [`chatAdmin/${chatKey}/wn/${key}/cancelReason`]: reason, [`chatAdmin/_global/wnPending/${chatKey}_${key}`]: null });
        await logWn(chatKey, { t: 'cancel', n, actor: actor.id, actorName: actor.name, to: w.to, toName: w.toName, reason, details: 'выдано ' + fmtUtc(w.at) });
        await dm(w.to, `✅ Предупреждение №${n} отменено руководством (${actor.name}). Причина отмены: ${reason}`);
        await say(chat.id, `✅ Предупреждение №${n} (${cleanText(w.toName, 40)}) отменено досрочно. Причина: ${reason}`);
      } else {
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/wn/${key}`]: null, [`chatAdmin/_global/wnPending/${chatKey}_${key}`]: null });
        await logWn(chatKey, { t: 'delete', n, actor: actor.id, actorName: actor.name, to: w.to, toName: w.toName, reason, details: `было: «${cleanText(w.reason, 120)}», выдано ${fmtUtc(w.at)}, статус ${warnStatus(w, t0)}` });
        await say(chat.id, `🗑 Предупреждение №${n} (${cleanText(w.toName, 40)}) удалено. Действие записано в журнал (/awlog).`);
      }
      return true;
    }

    // ----- старшие администраторы -----
    if (name === 'senior') {
      const sub = (cmd.args.split(/\s+/)[0] || '').toLowerCase();
      if (sub === 'list' || sub === '') {
        const ids = await readSeniors(chatKey);
        const o = await deps.dbGet(`chatAdmin/${chatKey}/wnSeniors`).catch(() => null) || {};
        await say(chat.id, '👑 Старшие администраторы (могут выдавать предупреждения):\n' + (ids.length ? ids.map((i) => `• ${cleanText(o[i] && o[i].name, 40) || i} (${i})`).join('\n') : 'не назначены') + '\nРуководство (создатель чата и владелец проекта) — всегда. Назначить: /senior add (ответом или id), снять: /senior del.');
        return true;
      }
      if (sub !== 'add' && sub !== 'del') { await tmp('Использование: /senior list | /senior add | /senior del (ответом на сообщение или по id).'); return true; }
      if (!(await isLeadership(chat.id, fromId))) { await tmp('Назначать старших администраторов может только руководство.'); return true; }
      const tg = await resolveTarget(msg, cmd.args.replace(/^\S+\s*/, ''));
      if (!tg || !userKeyOf(tg.id)) { await tmp('Ответьте командой на сообщение человека или укажите его числовой id.'); return true; }
      const tname = tg.user ? displayName(tg.user) : cleanText(tg.name, 60);
      if (sub === 'add') {
        if (!(await isChatAdmin(chat.id, tg.id))) { await tmp('Старшим можно назначить только администратора чата.'); return true; }
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/wnSeniors/${tg.id}`]: { name: tname, by: actor.id, at: t0 } });
        await logWn(chatKey, { t: 'senior_add', actor: actor.id, actorName: actor.name, to: String(tg.id), toName: tname });
        await say(chat.id, `👑 ${tname} назначен старшим администратором.`);
      } else {
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/wnSeniors/${tg.id}`]: null });
        await logWn(chatKey, { t: 'senior_del', actor: actor.id, actorName: actor.name, to: String(tg.id), toName: tname });
        await say(chat.id, `${tname} больше не старший администратор.`);
      }
      return true;
    }
    return false;
  }

  // Cron раз в минуту: предупреждения, у которых вышел срок, помечаются «истекло», человеку уходит уведомление
  async function sweep() {
    const t0 = now();
    const q = await deps.dbGet('chatAdmin/_global/wnPending').catch(() => null);
    if (!q || typeof q !== 'object') return 0;
    const due = Object.entries(q).filter(([, until]) => Number(until) <= t0).slice(0, 15);
    let done = 0;
    for (const [k, until] of due) {
      const m = /^(-?\d{1,20})_(w\d{1,9})$/.exec(k);
      if (!m) { await deps.dbUpdate({ [`chatAdmin/_global/wnPending/${k}`]: null }).catch(() => {}); continue; }
      const [, chatKey, wk] = m;
      const w = await deps.dbGet(`chatAdmin/${chatKey}/wn/${wk}`).catch(() => undefined);
      if (w === undefined) continue; // база не ответила — попробуем на следующей минуте
      if (w && typeof w === 'object' && w.status === 'active') {
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/wn/${wk}/status`]: 'expired', [`chatAdmin/${chatKey}/wn/${wk}/expiredAt`]: t0, [`chatAdmin/_global/wnPending/${k}`]: null });
        const n = Number(wk.slice(1));
        await logWn(chatKey, { t: 'expire', n, to: w.to, toName: w.toName, reason: w.reason, until: Number(until) });
        const left = (await readWarns(chatKey)).filter((x) => x.to === w.to && isActiveWarn(x, t0)).length;
        await dm(w.to, `ℹ️ Срок предупреждения №${n} истёк (выдано ${fmtUtc(w.at)}, причина: ${cleanText(w.reason, 150)}). Действующих предупреждений: ${left}.`);
        done++;
      } else {
        await deps.dbUpdate({ [`chatAdmin/_global/wnPending/${k}`]: null }).catch(() => {});
      }
    }
    return done;
  }

  return { handles, onCommand, sweep };
}
