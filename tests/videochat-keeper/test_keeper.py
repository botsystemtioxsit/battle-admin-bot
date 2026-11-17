import asyncio, sys, types, unittest
sys.path.insert(0, 'tools/videochat-keeper')
import keeper

class Channel: pass
class Full: 
    def __init__(s, call): s.full_chat = types.SimpleNamespace(call=call)
class R:
    GetFullChannel = lambda e: ('fc', e)
    GetFullChat = lambda i: ('fchat', i)
    CreateGroupCall = lambda **k: ('create', k)
    GetGroupCall = lambda **k: ('get', k)
    ToggleGroupCallRecord = lambda **k: ('rec', k)

class Client:
    def __init__(s, call=None, recording=False, fail_create=False):
        s.call, s.recording, s.fail_create, s.log = call, recording, fail_create, []
    async def get_entity(s, ref): return Channel()
    async def __call__(s, req):
        s.log.append(req[0])
        if req[0] == 'fc': return Full(s.call)
        if req[0] == 'create':
            if not s.fail_create: s.call = object()
            return None
        if req[0] == 'get': return types.SimpleNamespace(call=types.SimpleNamespace(record_start_date=1 if s.recording else None))
        if req[0] == 'rec': s.recording = True; return None

def run(c, **k): return asyncio.run(keeper.ensure_chat(c, -100123, R, **k))

class T(unittest.TestCase):
    def test_no_call_creates_and_records(self):
        c = Client(); r = run(c)
        self.assertIn('создан', r); self.assertIn('create', c.log); self.assertIn('rec', c.log)
    def test_running_not_recorded_starts_record(self):
        c = Client(call=object()); r = run(c)
        self.assertNotIn('create', c.log); self.assertIn('rec', c.log); self.assertIn('запись включена', r)
    def test_running_and_recording_changes_nothing(self):
        c = Client(call=object(), recording=True); r = run(c)
        self.assertEqual([x for x in c.log if x in ('create', 'rec')], []); self.assertIn('запись идёт', r)
    def test_record_off(self):
        c = Client(call=object()); run(c, record=False); self.assertNotIn('rec', c.log)
    def test_create_fails(self):
        c = Client(fail_create=True); self.assertIn('не удалось', run(c))
    def test_parse(self):
        self.assertEqual(keeper.parse_chats('-1001, @name\n 77 ,'), [-1001, '@name', 77])

unittest.main()
