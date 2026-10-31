import importlib.util
import socket
import struct
import json
import tempfile
import threading
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('ping_codex', Path(__file__).with_name('ping_codex.py'))
ping = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ping)


class DeliveryTests(unittest.TestCase):
    def exercise(self, outcome):
        queued, methods = [], []
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / 'ipc.sock')
            server = socket.socket(socket.AF_UNIX)
            server.bind(path)
            server.listen(1)

            def serve():
                with server, server.accept()[0] as conn:
                    stream = conn.makefile('rb')
                    while True:
                        header = stream.read(4)
                        if not header:
                            break
                        req = json.loads(stream.read(struct.unpack('<I', header)[0]))
                        methods.append(req['method'])
                        reply = {'type': 'response', 'requestId': req['requestId'], 'resultType': 'success'}
                        if req['method'] == 'initialize':
                            reply['result'] = {'clientId': 'test-client'}
                        elif req['method'] == 'thread-owner-discovery':
                            reply['handledByClientId'] = 'desktop-owner'
                        elif req['method'] == 'thread-follower-start-turn':
                            if outcome == 'idle_lost':
                                break
                            self.assertTrue(req['params']['turnStart']['context']['inheritThreadSettings'])
                            reply['result'] = {'result': {'turn': {'id': 'new-turn'}}}
                        elif outcome == 'lost':
                            break
                        elif outcome in ('idle', 'idle_lost'):
                            reply.update(resultType='error', error='Cannot steer conversation target because its active turn already ended')
                        else:
                            self.assertEqual(req['params']['conversationId'], 'target')
                            self.assertEqual(req['targetClientId'], 'desktop-owner')
                            self.assertEqual(req['params']['input'][0]['text_elements'], [])
                            reply['result'] = {'result': {'turnId': 'active-turn'}}
                        body = json.dumps(reply).encode()
                        conn.sendall(struct.pack('<I', len(body)) + body)

            worker = threading.Thread(target=serve, daemon=True)
            worker.start()
            try:
                result = ping.deliver('target', 'peer message', path, lambda *args: queued.append(args))
                return result, queued, methods
            finally:
                worker.join(timeout=3)

    def test_active_turn_is_steered_without_queueing(self):
        result, queued, methods = self.exercise('active')
        self.assertEqual(result['delivery'], 'steered')
        self.assertEqual(result['turn_id'], 'active-turn')
        self.assertEqual(queued, [])
        self.assertEqual(methods[-1], 'thread-follower-steer-turn')

    def test_idle_turn_starts_without_queueing(self):
        result, queued, methods = self.exercise('idle')
        self.assertEqual(result['delivery'], 'started')
        self.assertEqual(result['turn_id'], 'new-turn')
        self.assertEqual(queued, [])
        self.assertEqual(methods[-1], 'thread-follower-start-turn')

    def test_lost_steer_reply_never_queues_duplicate(self):
        with self.assertRaises(ping.DeliveryUnknown):
            self.exercise('lost')

    def test_lost_start_reply_never_queues_duplicate(self):
        with self.assertRaises(ping.DeliveryUnknown):
            self.exercise('idle_lost')

    def test_missing_desktop_uses_queue_sender(self):
        queued = []
        result = ping.deliver('target', 'peer message', '/nonexistent/codex-ipc.sock', lambda *args: queued.append(args))
        self.assertEqual(result['delivery'], 'queued')
        self.assertEqual(queued, [('target', 'peer message')])


if __name__ == '__main__':
    unittest.main()
