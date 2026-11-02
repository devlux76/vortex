#!/usr/bin/env python3
"""Offline regression tests for netlab.py harness logic (no VMs): python3 -m unittest test_netlab"""
import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('netlab', HERE / 'netlab.py')
netlab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(netlab)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name)
        self.patches = [mock.patch.object(netlab, 'RUN', self.run), mock.patch.object(netlab.time, 'sleep', lambda s: None)]
        for p in self.patches:
            p.start()
        (self.run / 'profile').write_text('wan')

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()


class FaultInjection(Base):
    def test_failed_mutation_raises(self):
        # Like the real ssh(): every remote command exits 1; only check=True surfaces it.
        def ssh(node, cmd, check=True, **kw):
            if check:
                raise RuntimeError(f'{node}: exited 1')
            return ''
        with mock.patch.object(netlab, 'ssh', ssh):
            with self.assertRaises(RuntimeError):
                netlab.set_link_fault('a-c1', 'blackhole', True)

    def test_unobserved_transition_raises(self):
        # Every command "succeeds" but the qdisc never shows 100% loss.
        def ssh(node, cmd, check=True, **kw):
            return 'qdisc fq_codel 0: root' if 'qdisc show' in cmd else ''
        with mock.patch.object(netlab, 'ssh', ssh):
            with self.assertRaisesRegex(RuntimeError, 'not observed'):
                netlab.set_link_fault('a-c1', 'blackhole', True)

    def test_observed_evidence_returned_for_both_ends(self):
        state = {}
        def ssh(node, cmd, check=True, **kw):
            if 'qdisc add' in cmd:
                state[node] = 'loss 100%' if 'loss random 100%' in cmd else 'delay 15ms 5ms loss 1%'
            if 'qdisc show' in cmd:
                return f'qdisc netem 8001: root {state.get(node, "")}'
            return ''
        with mock.patch.object(netlab, 'ssh', ssh):
            on = netlab.set_link_fault('a-c1', 'blackhole', True)
            off = netlab.set_link_fault('a-c1', 'blackhole', False)
        self.assertEqual(set(on), {'r-a', 'core1'})
        self.assertTrue(all('loss 100%' in v for v in on.values()))
        self.assertTrue(all('delay 15ms' in v and 'loss 1%' in v for v in off.values()))

    def test_chaos_heals_active_fault_on_interruption(self):
        calls = []
        def fault(link, mode, on):
            calls.append((link, mode, on))
            return {'x': 'observed'}
        sleeps = iter([KeyboardInterrupt('signal 15')])
        def sleep(_s):
            raise next(sleeps)
        with mock.patch.object(netlab, 'set_link_fault', fault), mock.patch.object(netlab.time, 'sleep', sleep):
            with self.assertRaises(SystemExit) as cm:
                netlab.cmd_chaos(SimpleNamespace(duration=60, every=30, down=12, mode='blackhole', seed=1))
        self.assertEqual(cm.exception.code, 1)
        self.assertEqual(calls[0][2], True)
        self.assertEqual(calls[-1], (calls[0][0], 'blackhole', False), 'active fault healed')
        events = [json.loads(l)['event'] for l in (self.run / 'chaos.jsonl').read_text().splitlines()]
        self.assertEqual(events, ['start', 'fail', 'error', 'heal-on-error', 'end'])


def evidence(role, host, nonces, ok=True, started=None, valid=True):
    started = started or time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    return {'role': role, 'host': host, 'ok': ok, 'started': started,
            'rounds': [{'n': i + 1, 'nonce': n, 'valid': valid} for i, n in enumerate(nonces)]}


class PeerCheck(Base):
    def run_check(self, rc_a, rc_b, a_ev, b_ev):
        def ssh(node, cmd, check=True, **kw):
            if node == 'peer-a' and 'role initiate' in cmd:
                return f'{rc_a}\n'
            if node == 'peer-b' and 'b.rc' in cmd and cmd.startswith('cat'):
                return f'{rc_b}\n'
            return ''
        def scp_from(node, src, dst):
            Path(dst).write_text(json.dumps(a_ev if node == 'peer-a' else b_ev))
        with mock.patch.object(netlab, 'ssh', ssh), mock.patch.object(netlab, 'scp_from', scp_from):
            netlab.cmd_peer_check(SimpleNamespace(rounds=2))

    def test_bad_launch_with_stale_files_fails(self):
        stale = {'ok': True, 'started': '2000-01-01T00:00:00.000Z', 'rounds': [], 'role': 'initiate', 'host': 'peer-a'}
        stale_b = dict(stale, role='respond', host='peer-b')
        with self.assertRaises(SystemExit) as cm:
            self.run_check(1, 0, stale, stale_b)
        self.assertEqual(cm.exception.code, 1)
        verdict = json.loads(next((self.run / 'evidence').glob('*-verdict.json')).read_text())
        text = ' '.join(verdict['problems'])
        self.assertIn('initiator exit 1', text)
        self.assertIn('stale evidence', text)
        self.assertIn('0 rounds, expected 2', text)

    def test_responder_failure_propagates(self):
        n = ['r1-1', 'r1-2']
        with self.assertRaises(SystemExit):
            self.run_check(0, 1, evidence('initiate', 'peer-a', n), evidence('respond', 'peer-b', n, ok=False))

    def test_unpaired_nonces_fail(self):
        with self.assertRaises(SystemExit):
            self.run_check(0, 0, evidence('initiate', 'peer-a', ['r1-1', 'r1-2']), evidence('respond', 'peer-b', ['r0-7', 'r0-8']))

    def test_consistent_pair_passes(self):
        n = ['r1-1', 'r1-2']
        self.run_check(0, 0, evidence('initiate', 'peer-a', n), evidence('respond', 'peer-b', n))
        verdict = json.loads(next((self.run / 'evidence').glob('*-verdict.json')).read_text())
        self.assertTrue(verdict['ok'])


if __name__ == '__main__':
    unittest.main()
