"""Держит видеочат Telegram включённым в указанных группах и включает его запись.

Работает от имени ОТДЕЛЬНОГО аккаунта (не основного!), у которого в группе есть право
«Управление видеочатами». Ничего не висит постоянно: GitHub Actions запускает скрипт по расписанию,
скрипт за секунды проверяет каждую группу и, если видеочата нет, создаёт его заново и включает запись.
Звук и видео скрипт не передаёт (в чат он не «входит» как участник) — только управляет самим видеочатом.

Секреты (GitHub → Settings → Secrets): TG_API_ID, TG_API_HASH, TG_SESSION (строка сессии из login.py),
TG_CHATS (группы через запятую: номер -100… или @имя). Необязательные: TG_RECORD (1/0, по умолчанию 1),
TG_TITLE (название записи).
Журнал публичный (репозиторий открыт) — в нём только номера по порядку, не названия и не номера групп.
"""
import asyncio
import os
import random
import sys


async def ensure_chat(client, ref, R, record=True, title=''):
    """Возвращает короткий итог по одной группе. R — набор классов запросов Telegram (подменяется в тесте)."""
    entity = await client.get_entity(ref)
    is_channel = type(entity).__name__ == 'Channel'
    full = await client(R.GetFullChannel(entity) if is_channel else R.GetFullChat(entity.id))
    call = getattr(full.full_chat, 'call', None)
    created = False
    if call is None:
        await client(R.CreateGroupCall(peer=entity, random_id=random.randint(1, 2**31 - 1)))
        created = True
        full = await client(R.GetFullChannel(entity) if is_channel else R.GetFullChat(entity.id))
        call = getattr(full.full_chat, 'call', None)
        if call is None:
            return 'не удалось создать видеочат'
    recording = False
    if record:
        info = await client(R.GetGroupCall(call=call, limit=1))
        recording = bool(getattr(info.call, 'record_start_date', None))
        if not recording:
            await client(R.ToggleGroupCallRecord(call=call, start=True, title=title or None))
            recording = True
            return ('видеочат создан, ' if created else 'видеочат был, ') + 'запись включена'
    return ('видеочат создан' if created else 'видеочат идёт') + (', запись идёт' if recording else '')


def parse_chats(raw):
    out = []
    for part in (raw or '').replace('\n', ',').split(','):
        p = part.strip()
        if not p:
            continue
        out.append(int(p) if p.lstrip('-').isdigit() else p)
    return out


def telethon_requests():
    from telethon.tl.functions.channels import GetFullChannelRequest
    from telethon.tl.functions.messages import GetFullChatRequest
    from telethon.tl.functions.phone import CreateGroupCallRequest, GetGroupCallRequest, ToggleGroupCallRecordRequest

    class R:
        GetFullChannel = GetFullChannelRequest
        GetFullChat = GetFullChatRequest
        CreateGroupCall = CreateGroupCallRequest
        GetGroupCall = GetGroupCallRequest
        ToggleGroupCallRecord = ToggleGroupCallRecordRequest
    return R


async def main():
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.functions.channels import GetFullChannelRequest
    from telethon.tl.functions.messages import GetFullChatRequest
    from telethon.tl.functions.phone import CreateGroupCallRequest, GetGroupCallRequest, ToggleGroupCallRecordRequest

    class R:
        GetFullChannel = GetFullChannelRequest
        GetFullChat = GetFullChatRequest
        CreateGroupCall = CreateGroupCallRequest
        GetGroupCall = GetGroupCallRequest
        ToggleGroupCallRecord = ToggleGroupCallRecordRequest

    chats = parse_chats(os.environ.get('TG_CHATS'))
    if not chats:
        print('TG_CHATS пуст — нечего делать')
        return 1
    client = TelegramClient(StringSession(os.environ['TG_SESSION']), int(os.environ['TG_API_ID']), os.environ['TG_API_HASH'])
    await client.connect()
    if not await client.is_user_authorized():
        print('Сессия больше не действует: запустите login.py заново и обновите секрет TG_SESSION')
        return 2
    record = os.environ.get('TG_RECORD', '1') != '0'
    bad = 0
    for i, ref in enumerate(chats, 1):
        try:
            print(f'группа {i}: ' + await ensure_chat(client, ref, R, record, os.environ.get('TG_TITLE', '')))
        except Exception as e:  # текст ошибки без номеров групп
            bad += 1
            print(f'группа {i}: ошибка — {type(e).__name__}: {str(e)[:120]}')
    await client.disconnect()
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
