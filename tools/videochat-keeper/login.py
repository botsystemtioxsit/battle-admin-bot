"""Один раз на ВАШЕМ компьютере: получить строку сессии отдельного аккаунта.
  pip install telethon
  python login.py
Спросит api_id и api_hash (my.telegram.org → API development tools), номер телефона отдельного аккаунта и код из Telegram.
Напечатанную строку положите в секрет GitHub TG_SESSION. Строка = полный доступ к аккаунту: никому не показывайте.
"""
from telethon import TelegramClient
from telethon.sessions import StringSession

api_id = int(input('api_id: ').strip())
api_hash = input('api_hash: ').strip()
with TelegramClient(StringSession(), api_id, api_hash) as client:
    print('\nTG_SESSION (скопируйте целиком):\n' + client.session.save())
