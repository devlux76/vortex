"""Paired peer-check evidence validation (moved from netlab.py; 500-line rule)."""
import calendar
import time


def utc_epoch(stamp) -> float:
    """ISO-8601 UTC ('...Z') to epoch seconds; 0 if unparseable. timegm, not mktime: no local-zone/DST skew."""
    try:
        return float(calendar.timegm(time.strptime(str(stamp or '')[:19], '%Y-%m-%dT%H:%M:%S')))
    except ValueError:
        return 0.0


def validate_pair(a: dict, b: dict, rounds: int, run_started: float, rc_a: int | None, rc_b: int | None) -> list:
    """Paired evidence checks before success. Returns a list of problems (empty = valid).

    Field contract (tools/peer-check.ts): initiator round sentId=PING id, replyId=PONG id, scope=requested,
    replyScope=actual; responder round replyId=PING id it answered, sentId=its PONG id, scope=PING scope."""
    problems = []
    if rc_a != 0:
        problems.append(f'initiator exit {rc_a}')
    if rc_b != 0:
        problems.append(f'responder exit {rc_b}')
    for side, e, role in (('a', a, 'initiate'), ('b', b, 'respond')):
        if e.get('role') != role:
            problems.append(f'{side}: role {e.get("role")!r} != {role}')
        if e.get('ok') is not True:
            problems.append(f'{side}: ok={e.get("ok")!r} error={e.get("error")!r}')
        if utc_epoch(e.get('started')) < run_started - 120:
            problems.append(f'{side}: stale evidence (started {e.get("started")!r} before this run)')
    ra = a.get('rounds') or []
    rb = b.get('rounds') or []
    by_nonce = {}
    for side, rs in (('a', ra), ('b', rb)):
        if len(rs) != rounds:
            problems.append(f'{side}: {len(rs)} rounds, expected {rounds}')
        nonces = [str(r.get('nonce', '')) for r in rs]
        dups = sorted({n for n in nonces if nonces.count(n) > 1})
        if dups:
            problems.append(f'{side}: duplicate nonces {dups[:4]}')
        by_nonce[side] = {str(r.get('nonce', '')): r for r in rs}
    if not all(r.get('valid') is True for r in ra):
        problems.append('a: not every round valid')
    run_ids = {str(r.get('nonce', '')).rsplit('-', 1)[0] for r in ra}
    if len(run_ids) != 1:
        problems.append(f'a: rounds span run ids {sorted(run_ids)}')
    a_nonces, b_nonces = set(by_nonce['a']), set(by_nonce['b'])
    if a_nonces != b_nonces:
        problems.append(f'pairing: responder answered {len(b_nonces)} nonces, initiator sent {len(a_nonces)}; mismatch {sorted(a_nonces ^ b_nonces)[:4]}')
    for nonce in sorted(a_nonces & b_nonces):
        x, y = by_nonce['a'][nonce], by_nonce['b'][nonce]
        if not x.get('sentId') or x.get('sentId') != y.get('replyId'):
            problems.append(f'pairing {nonce}: PING a.sentId {x.get("sentId")!r} != b.replyId {y.get("replyId")!r}')
        if not x.get('replyId') or x.get('replyId') != y.get('sentId'):
            problems.append(f'pairing {nonce}: PONG a.replyId {x.get("replyId")!r} != b.sentId {y.get("sentId")!r}')
        if not x.get('scope') or not (x.get('scope') == y.get('scope') == x.get('replyScope')):
            problems.append(f'pairing {nonce}: scope a={x.get("scope")!r} b={y.get("scope")!r} reply={x.get("replyScope")!r}')
    if a.get('host') == b.get('host'):
        problems.append('a and b report the same host')
    return problems
