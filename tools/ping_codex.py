#!/usr/bin/env python3
"""Deliver peer input through the desktop owner: steer active turns, start idle ones."""
import argparse
import json
import os
import socket
import stat
import struct
import subprocess
import sys
import uuid
from pathlib import Path

CODEX = '/usr/lib/chatgpt/resources/codex'


class Rejected(Exception):
    pass


class DeliveryUnknown(Exception):
    pass


class Desktop:
    def __init__(self, path):
        info = os.stat(path)
        if info.st_uid != os.getuid() or not stat.S_ISSOCK(info.st_mode):
            raise PermissionError('desktop IPC socket is not owned by this user')
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(15)
        try:
            self.sock.connect(path)
        except OSError:
            self.sock.close()
            raise
        self.client = 'initializing-client'

    def close(self):
        self.sock.close()

    def read(self, count):
        data = b''
        while len(data) < count:
            part = self.sock.recv(count - len(data))
            if not part:
                raise ConnectionError('desktop IPC closed before its reply')
            data += part
        return data

    def send(self, obj):
        raw = json.dumps(obj).encode()
        self.sock.sendall(struct.pack('<I', len(raw)) + raw)

    def request(self, method, params, version=0, target=None):
        request_id = str(uuid.uuid4())
        message = dict(type='request', requestId=request_id, sourceClientId=self.client,
                       version=version, method=method, params=params)
        if target:
            message['targetClientId'] = target
        self.send(message)
        while True:
            size = struct.unpack('<I', self.read(4))[0]
            if size > 16 * 1024 * 1024:
                raise ConnectionError('desktop IPC frame exceeds limit')
            response = json.loads(self.read(size))
            if response.get('type') == 'client-discovery-request':
                self.send(dict(type='client-discovery-response', requestId=response['requestId'],
                               response={'canHandle': False}))
            if response.get('type') != 'response' or response.get('requestId') != request_id:
                continue
            if response.get('resultType') != 'success':
                raise Rejected(response.get('error', 'desktop request rejected'))
            return response


def queue_for_resume(thread, text):
    subprocess.run([CODEX, 'queue', '--thread', thread, '--message', text, '--resume'], check=True)


def deliver(thread, text, socket_path=None, queue_sender=None):
    queue_sender = queue_sender or queue_for_resume

    def queued():
        queue_sender(thread, text)
        return {'delivery': 'queued', 'thread': thread}

    path = socket_path or str(Path.home() / '.codex/ipc/ipc.sock')
    try:
        desktop = Desktop(path)
    except (FileNotFoundError, ConnectionRefusedError):
        return queued()
    try:
        desktop.client = desktop.request('initialize', {'clientType': 'cli'})['result']['clientId']
        try:
            owner = desktop.request('thread-owner-discovery',
                                    {'hostId': 'local', 'conversationId': thread}, 1)['handledByClientId']
        except Rejected as error:
            if str(error) == 'no-client-found':
                return queued()
            raise
        message_id = str(uuid.uuid4())
        inputs = [{'type': 'text', 'text': text, 'text_elements': []}]
        params = {'conversationId': thread, 'input': inputs, 'attachments': [],
                  'restoreMessage': {'id': message_id, 'input': inputs, 'text': text,
                                     'context': {'commentAttachments': []}},
                  'clientUserMessageId': message_id}
        try:
            result = desktop.request('thread-follower-steer-turn', params, 1, owner)
        except Rejected as error:
            reason = str(error)
            if ('active turn already ended' in reason or 'is not being streamed' in reason
                    or 'NoActiveTurn' in reason):
                turn_start = {
                    'request': {'threadId': thread, 'input': inputs,
                                'clientUserMessageId': message_id},
                    'context': {'inheritThreadSettings': True, 'attachments': [],
                                'commentAttachments': []},
                }
                try:
                    started = desktop.request('thread-follower-start-turn',
                                              {'conversationId': thread, 'turnStart': turn_start},
                                              2, owner)
                except (OSError, ValueError) as start_error:
                    raise DeliveryUnknown('start outcome unknown; not queued again: %s'
                                          % start_error) from start_error
                return {'delivery': 'started', 'thread': thread,
                        'turn_id': started['result']['result']['turn']['id']}
            raise
        except (OSError, ValueError) as error:
            # The desktop may already have admitted the message. Never queue a duplicate.
            raise DeliveryUnknown('steer outcome unknown; not queued again: %s' % error) from error
        return {'delivery': 'steered', 'thread': thread,
                'turn_id': result['result']['result']['turnId']}
    finally:
        desktop.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('message')
    args = parser.parse_args()
    pinned = Path.home() / '.local/state/ping-codex.thread'
    thread = os.environ.get('CODEX_THREAD') or (pinned.read_text().strip() if pinned.exists() else '')
    if not thread:
        parser.error('set CODEX_THREAD or pin a target in ~/.local/state/ping-codex.thread')
    text = 'From %s (via ping-codex): %s' % (os.environ.get('PING_FROM', 'Claude'), args.message)
    try:
        print(json.dumps(deliver(thread, text)))
        return 0
    except (OSError, ValueError, Rejected, DeliveryUnknown, subprocess.CalledProcessError) as error:
        print('ping-codex: %s' % error, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
