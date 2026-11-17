"""Аккаунт ЗАХОДИТ в видеочат Telegram участником (тишина) и держится там; видеочат создаётся и запись включается
(keeper.ensure_chat). Живёт RUN_SECONDS (по умолчанию 5 ч 40 мин — предел задачи GitHub 6 ч), потом workflow сам
запускает следующий проход. Раз в минуту проверяет: видеочата нет — создаёт заново; из чата выпали — заходит снова.
Нужны те же секреты, что у keeper.py, плюс ffmpeg (на GitHub-раннере есть) и py-tgcalls.
"""
import asyncio
import os
import subprocess
import sys
import time

import keeper

SILENCE = 'silence.mp3'


def make_silence():
    if not os.path.exists(SILENCE):
        subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '3600', '-q:a', '9', SILENCE],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def main():
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from pytgcalls import PyTgCalls
    from pytgcalls.types import MediaStream

    secret_chats = keeper.parse_chats(os.environ.get('TG_CHATS'))
    make_silence()
    client = TelegramClient(StringSession(os.environ['TG_SESSION']), int(os.environ['TG_API_ID']), os.environ['TG_API_HASH'])
    await client.connect()
    if not await client.is_user_authorized():
        print('Сессия больше не действует: login.py и новый TG_SESSION')
        return 2
    R = keeper.telethon_requests()
    calls = PyTgCalls(client)
    await calls.start()
    record = os.environ.get('TG_RECORD', '1') != '0'
    deadline = time.time() + int(os.environ.get('RUN_SECONDS', str(5 * 3600 + 40 * 60)))
    inside = set()
    while time.time() < deadline:
        cfg = keeper.fetch_config()
        if cfg is None:
            cfg = {'enabled': True, 'chats': []}  # база не ответила — держим то, что задано секретом
        chats = list(dict.fromkeys(cfg['chats'] + secret_chats))
        if not cfg['enabled'] or not chats:
            for cid in list(inside):  # выключили из Терминала (или список пуст) — выходим из видеочатов
                try:
                    await calls.leave_call(cid)
                except Exception:
                    pass
            inside.clear()
            print('хранитель выключен или список групп пуст — жду')
            await asyncio.sleep(60)
            continue
        for i, ref in enumerate(chats, 1):
            try:
                ent = await client.get_entity(ref)
                msg = await keeper.ensure_chat(client, ref, R, record, os.environ.get('TG_TITLE', ''))
                alive = False
                if ent.id in inside:
                    try:
                        await calls.played_time(ent.id)
                        alive = True
                    except Exception:
                        inside.discard(ent.id)
                if not alive:
                    await calls.play(ent.id, MediaStream(SILENCE))
                    inside.add(ent.id)
                    msg += '; вошёл в видеочат'
                print(f'группа {i}: {msg}')
            except Exception as e:
                inside.discard(getattr(locals().get('ent'), 'id', None))
                print(f'группа {i}: ошибка — {type(e).__name__}: {str(e)[:120]}')
        await asyncio.sleep(60)
    for cid in list(inside):
        try:
            await calls.leave_call(cid)
        except Exception:
            pass
    await client.disconnect()
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
