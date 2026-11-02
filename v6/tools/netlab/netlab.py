#!/usr/bin/env python3
"""VORTEX v6 netlab: an emulated multi-hop WAN of QEMU VMs on one host.

Topology (8 VMs). Every site has two independent paths through the core:

    peer-a --lan-a-- r-a ==a-c1== core1 ==h-c1== r-h --lan-h-- hub
                       \\\\==a-c2== core2 ==h-c2==//
    peer-b --lan-b-- r-b ==b-c1== core1   core1 ==c1-c2== core2
                       \\\\==b-c2== core2

* Data links are point-to-point UDP tunnels between QEMU processes
  (-netdev dgram on loopback). Nothing is created on the host network:
  no bridges, taps, namespaces or firewall rules, and no root.
* Every VM also has a private user-mode management NIC (SSH via a loopback
  hostfwd). Test addresses (10.10/16, 10.255/16) route only over the data
  links, so test traffic cannot leak around the emulated WAN.
* Routers run FRR OSPF (hello 1 s, dead 4 s): a dead link reroutes in ~4-5 s.
* Impairment: tc netem on core-facing interfaces (both ends' egress);
  chaos: scripted core link flaps.

Label for any evidence produced here: MULTI-VM EMULATED WAN, SINGLE PHYSICAL
HOST. It is not a second physical device.

Usage: netlab.py build-base | up | down | status | ssh NODE CMD... |
       impair PROFILE|clear | chaos [--duration S --every S --down S] |
       deploy-vortex REPO | peer-check [--rounds N]
"""
import argparse
import ipaddress
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
RUN = Path(os.environ.get('NETLAB_DIR', HOME / '.cache' / 'vortex-netlab'))
IMAGE = Path(os.environ.get('NETLAB_IMAGE', HOME / '.cache' / 'vortex-v6-vm' / 'debian-12-genericcloud-amd64.qcow2'))
BASE = RUN / 'base.qcow2'
KEY = RUN / 'id_ed25519'
PORT_BASE = int(os.environ.get('NETLAB_PORT_BASE', '41000'))
SSH_BASE = int(os.environ.get('NETLAB_SSH_BASE', '22300'))

# name: (role, memory MiB, {link: cidr}, gateway for hosts)
NODES = {
    'peer-a': ('host', 768, {'lan-a': '10.10.1.10/24'}, '10.10.1.1'),
    'peer-b': ('host', 768, {'lan-b': '10.10.2.10/24'}, '10.10.2.1'),
    'hub':    ('host', 768, {'lan-h': '10.10.9.10/24'}, '10.10.9.1'),
    'r-a':    ('router', 384, {'lan-a': '10.10.1.1/24', 'a-c1': '10.255.1.1/30', 'a-c2': '10.255.2.1/30'}, None),
    'r-b':    ('router', 384, {'lan-b': '10.10.2.1/24', 'b-c1': '10.255.3.1/30', 'b-c2': '10.255.4.1/30'}, None),
    'r-h':    ('router', 384, {'lan-h': '10.10.9.1/24', 'h-c1': '10.255.5.1/30', 'h-c2': '10.255.6.1/30'}, None),
    'core1':  ('router', 384, {'a-c1': '10.255.1.2/30', 'b-c1': '10.255.3.2/30', 'h-c1': '10.255.5.2/30', 'c1-c2': '10.255.7.1/30'}, None),
    'core2':  ('router', 384, {'a-c2': '10.255.2.2/30', 'b-c2': '10.255.4.2/30', 'h-c2': '10.255.6.2/30', 'c1-c2': '10.255.7.2/30'}, None),
}
ORDER = list(NODES)
# Each link joins exactly two nodes, in this order (end 0, end 1).
LINKS = {}
for _n in ORDER:
    for _l in NODES[_n][2]:
        LINKS.setdefault(_l, []).append(_n)
LINK_ORDER = sorted(LINKS)
CORE_LINKS = [l for l in LINK_ORDER if not l.startswith('lan-')]
assert all(len(v) == 2 for v in LINKS.values()), LINKS

PROFILES = {
    # Per core hop, per direction; a peer-to-hub path crosses two core hops.
    # Uncorrelated 'loss random': correlated netem loss ('loss P CORR') drops
    # almost nothing on the 6.1 cloud kernel (measured), so it is not used.
    'wan': 'delay 15ms 5ms distribution normal loss random 1% duplicate 0.2% reorder 0.5% 50%',
    # Bursty loss via Gilbert-Elliott: ~3% enter-bad, 30% recover, bad state drops all.
    'lossy': 'delay 40ms 15ms distribution normal loss gemodel 1% 30% 100% 0% duplicate 0.5% reorder 1% 50%',
}


def mac(node: str, link: str) -> str:
    return '52:54:00:%02x:%02x:%02x' % (ORDER.index(node) + 1, LINK_ORDER.index(link) + 1, LINKS[link].index(node))


def mgmt_mac(node: str) -> str:
    return '52:54:00:ff:00:%02x' % (ORDER.index(node) + 1)


def ssh_port(node: str) -> int:
    return SSH_BASE + ORDER.index(node)


def link_ports(link: str, node: str) -> tuple:
    i = LINK_ORDER.index(link)
    end = LINKS[link].index(node)
    a, b = PORT_BASE + 2 * i, PORT_BASE + 2 * i + 1
    return (a, b) if end == 0 else (b, a)


def sh(cmd: list, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kw)


def ssh_cmd(node: str) -> list:
    return ['ssh', '-i', str(KEY), '-p', str(ssh_port(node)), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=5', 'lab@127.0.0.1']


def ssh(node: str, command: str, check: bool = True, capture: bool = True, timeout: int = 120) -> str:
    r = subprocess.run(ssh_cmd(node) + [command], capture_output=capture, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f'{node}: {command!r} exited {r.returncode}: {(r.stderr or "")[-400:]}')
    return r.stdout if capture else ''


def scp_to(node: str, src: str, dst: str) -> None:
    sh(['scp', '-q', '-r', '-i', str(KEY), '-P', str(ssh_port(node)), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR', src, f'lab@127.0.0.1:{dst}'])


def scp_from(node: str, src: str, dst: str) -> None:
    sh(['scp', '-q', '-i', str(KEY), '-P', str(ssh_port(node)), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR', f'lab@127.0.0.1:{src}', dst])


def seed_iso(path: Path, instance: str, hostname: str, user_data: str, network: dict | None) -> None:
    d = path.with_suffix('.d')
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    (d / 'meta-data').write_text(f'instance-id: {instance}\nlocal-hostname: {hostname}\n')
    (d / 'user-data').write_text(user_data)
    files = ['user-data', 'meta-data']
    if network is not None:
        (d / 'network-config').write_text(json.dumps(network))
        files.append('network-config')
    sh(['genisoimage', '-quiet', '-output', str(path), '-volid', 'cidata', '-joliet', '-rock'] + [str(d / f) for f in files])


def user_data(hostname: str, extra_runcmd: list, write_files: list | None = None, packages: list | None = None, poweroff: bool = False) -> str:
    pub = (KEY.with_suffix('.pub')).read_text().strip()
    doc = {
        'hostname': hostname,
        'users': [{'name': 'lab', 'sudo': 'ALL=(ALL) NOPASSWD:ALL', 'shell': '/bin/bash', 'ssh_authorized_keys': [pub]}],
        'ssh_pwauth': False,
        'package_update': bool(packages),
        'packages': packages or [],
        'write_files': write_files or [],
        'runcmd': extra_runcmd,
    }
    if poweroff:
        doc['power_state'] = {'mode': 'poweroff', 'timeout': 60, 'condition': True}
    return '#cloud-config\n' + json.dumps(doc)


def qemu_cmd(node: str, disk: Path, seed: Path, mem: int, data: bool = True) -> list:
    cmd = ['qemu-system-x86_64', '-enable-kvm', '-cpu', 'host', '-smp', '1', '-m', str(mem), '-display', 'none', '-daemonize',
           '-pidfile', str(RUN / f'{node}.pid'), '-serial', f'file:{RUN / (node + ".console.log")}',
           '-drive', f'file={disk},if=virtio,format=qcow2', '-drive', f'file={seed},if=virtio,format=raw,readonly=on',
           '-netdev', f'user,id=mgmt,hostfwd=tcp:127.0.0.1:{ssh_port(node)}-:22',
           '-device', f'virtio-net-pci,netdev=mgmt,mac={mgmt_mac(node)}']
    if data:
        for link in NODES[node][2]:
            lp, rp = link_ports(link, node)
            cmd += ['-netdev', f'dgram,id={link},local.type=inet,local.host=127.0.0.1,local.port={lp},'
                               f'remote.type=inet,remote.host=127.0.0.1,remote.port={rp}',
                    '-device', f'virtio-net-pci,netdev={link},mac={mac(node, link)}']
    return cmd


def wait_ssh(nodes: list, timeout: int = 240) -> None:
    end = time.time() + timeout
    pending = set(nodes)
    while pending and time.time() < end:
        for n in sorted(pending):
            r = subprocess.run(ssh_cmd(n) + ['cloud-init status --wait >/dev/null 2>&1; echo up'], capture_output=True, text=True, timeout=200)
            if r.stdout.strip().endswith('up'):
                pending.discard(n)
                print(f'  {n}: ready', flush=True)
        if pending:
            time.sleep(3)
    if pending:
        raise SystemExit(f'not ready: {sorted(pending)}; see {RUN}/<node>.console.log')


def cmd_build_base(_a) -> None:
    RUN.mkdir(parents=True, exist_ok=True)
    if not KEY.exists():
        sh(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'vortex-netlab', '-f', str(KEY)])
    if not IMAGE.exists():
        raise SystemExit(f'missing cloud image {IMAGE}')
    BASE.unlink(missing_ok=True)
    sh(['qemu-img', 'create', '-q', '-f', 'qcow2', '-b', str(IMAGE), '-F', 'qcow2', str(BASE), '4G'])
    ud = user_data('netlab-base', [
        'systemctl disable --now frr || true',
        'systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer || true',
        'sh -c "modprobe sch_netem && echo NETLAB_NETEM_OK || echo NETLAB_NETEM_MISSING" > /dev/ttyS0',
        'sh -c "vtysh --version | head -1; echo NETLAB_BASE_DONE" > /dev/ttyS0',
    ], packages=['frr', 'traceroute', 'mtr-tiny', 'iperf3', 'tcpdump', 'iproute2', 'curl'], poweroff=True)
    seed = RUN / 'base-seed.iso'
    seed_iso(seed, f'netlab-base-{int(time.time())}', 'netlab-base', ud, None)
    (RUN / 'base.console.log').unlink(missing_ok=True)
    cmd = ['qemu-system-x86_64', '-enable-kvm', '-cpu', 'host', '-smp', '2', '-m', '1024', '-display', 'none',
           '-serial', f'file:{RUN / "base.console.log"}', '-drive', f'file={BASE},if=virtio,format=qcow2',
           '-drive', f'file={seed},if=virtio,format=raw,readonly=on', '-netdev', 'user,id=mgmt', '-device', 'virtio-net-pci,netdev=mgmt']
    print('building base image (installs frr, netem check; powers off when done)...', flush=True)
    subprocess.run(cmd, check=True, timeout=1200)
    log = (RUN / 'base.console.log').read_text(errors='replace')
    print('netem:', 'OK' if 'NETLAB_NETEM_OK' in log else 'MISSING/UNKNOWN', '| base done:', 'NETLAB_BASE_DONE' in log)
    if 'NETLAB_BASE_DONE' not in log:
        raise SystemExit('base build did not finish; see base.console.log')


def network_config(node: str) -> dict:
    role, _mem, ifaces, gw = NODES[node]
    cfg = [{'type': 'physical', 'name': 'mgmt0', 'mac_address': mgmt_mac(node), 'subnets': [{'type': 'dhcp'}]}]
    for link, cidr in ifaces.items():
        subnet = {'type': 'static', 'address': cidr}
        if role == 'host':
            subnet['routes'] = [{'network': '10.10.0.0', 'netmask': '255.255.0.0', 'gateway': gw},
                                {'network': '10.255.0.0', 'netmask': '255.255.0.0', 'gateway': gw}]
        cfg.append({'type': 'physical', 'name': link, 'mac_address': mac(node, link), 'subnets': [subnet]})
    return {'version': 1, 'config': cfg}


def frr_conf(node: str) -> str:
    ifaces = NODES[node][2]
    rid = f'10.255.255.{ORDER.index(node) + 1}'
    out = ['frr defaults traditional', f'hostname {node}', 'log syslog informational', '!']
    for link in ifaces:
        if link.startswith('lan-'):
            out += [f'interface {link}', ' ip ospf passive', '!']
            continue
        out += [f'interface {link}', ' ip ospf network point-to-point', ' ip ospf hello-interval 1', ' ip ospf dead-interval 4', '!']
    out += ['router ospf', f' ospf router-id {rid}', ' timers throttle spf 50 100 1000']
    for cidr in ifaces.values():
        out.append(f' network {ipaddress.ip_interface(cidr).network} area 0')
    out += ['!', 'line vty', '!']
    return '\n'.join(out) + '\n'


def cmd_up(_a) -> None:
    if not BASE.exists():
        raise SystemExit('run build-base first')
    stamp = int(time.time())
    for node in ORDER:
        role, mem, _ifaces, _gw = NODES[node]
        disk = RUN / f'{node}.qcow2'
        disk.unlink(missing_ok=True)
        sh(['qemu-img', 'create', '-q', '-f', 'qcow2', '-b', str(BASE), '-F', 'qcow2', str(disk)])
        runcmd = ['sysctl -w net.ipv4.conf.all.rp_filter=0', 'sysctl -w net.ipv4.conf.default.rp_filter=0']
        files = []
        if role == 'router':
            files = [{'path': '/etc/frr/frr.conf', 'content': frr_conf(node), 'owner': 'frr:frr', 'permissions': '0640'}]
            runcmd += ['sysctl -w net.ipv4.ip_forward=1', "sed -i 's/^ospfd=no/ospfd=yes/' /etc/frr/daemons",
                       'systemctl enable frr', 'systemctl restart frr', 'modprobe sch_netem']
        seed = RUN / f'{node}-seed.iso'
        seed_iso(seed, f'{node}-{stamp}', node, user_data(node, runcmd, files), network_config(node))
        (RUN / f'{node}.console.log').unlink(missing_ok=True)
        sh(qemu_cmd(node, disk, seed, mem))
        print(f'started {node} (ssh 127.0.0.1:{ssh_port(node)})', flush=True)
    wait_ssh(ORDER)


def cmd_down(_a) -> None:
    for node in ORDER:
        pf = RUN / f'{node}.pid'
        if pf.exists():
            try:
                os.kill(int(pf.read_text().strip()), 15)
                print(f'stopped {node}')
            except ProcessLookupError:
                pass
            pf.unlink(missing_ok=True)


def cmd_ssh(a) -> None:
    sys.exit(subprocess.run(ssh_cmd(a.node) + [' '.join(a.command)]).returncode)


def cmd_status(_a) -> None:
    for r in ['r-a', 'r-b', 'r-h', 'core1', 'core2']:
        nb = ssh(r, "sudo vtysh -c 'show ip ospf neighbor' | tail -n +2 | awk 'NF{print $1, $3, $6}'", check=False)
        print(f'{r} OSPF neighbors:', ' | '.join(l for l in nb.strip().splitlines() if l) or '(none)')
    for src, dst in [('peer-a', '10.10.9.10'), ('peer-b', '10.10.9.10'), ('peer-a', '10.10.2.10')]:
        tr = ssh(src, f'traceroute -n -q 1 -w 1 {dst} | tail -n +2', check=False)
        print(f'{src} -> {dst}:', ' > '.join(l.split()[1] for l in tr.strip().splitlines() if len(l.split()) > 1))
    print('hub routes on r-a:', ssh('r-a', "ip route show 10.10.9.0/24 | tr -s ' '", check=False).strip())


def impair_targets() -> list:
    return [(n, l) for l in CORE_LINKS for n in LINKS[l]]


def cmd_impair(a) -> None:
    for node, link in impair_targets():
        if a.profile == 'clear':
            ssh(node, f'sudo tc qdisc del dev {link} root 2>/dev/null || true', check=False)
        else:
            # del + add: 'replace' on an existing netem keeps parameters not restated.
            ssh(node, f'sudo tc qdisc del dev {link} root 2>/dev/null; sudo tc qdisc add dev {link} root netem {PROFILES[a.profile]} limit 10000')
    (RUN / 'profile').write_text(a.profile)
    print(f'impairment {a.profile} on {len(impair_targets())} interfaces ({len(CORE_LINKS)} core links, both directions)')


def set_link_fault(link: str, mode: str, on: bool) -> None:
    """carrier: interface down (both ends notice at once); blackhole: interface up but
    100% loss, so OSPF only notices after its dead interval (4 s)."""
    prof = (RUN / 'profile').read_text().strip() if (RUN / 'profile').exists() else 'clear'
    for n in LINKS[link]:
        if mode == 'carrier':
            ssh(n, f'sudo ip link set dev {link} {"down" if on else "up"}', check=False)
        elif on:
            ssh(n, f'sudo tc qdisc del dev {link} root 2>/dev/null; sudo tc qdisc add dev {link} root netem loss random 100%', check=False)
        else:
            restore = f'sudo tc qdisc add dev {link} root netem {PROFILES[prof]} limit 10000' if prof in PROFILES else 'true'
            ssh(n, f'sudo tc qdisc del dev {link} root 2>/dev/null; {restore}', check=False)


def cmd_chaos(a) -> None:
    """Fail random core links (carrier loss or silent blackhole) for --down s, every --every s, for --duration s."""
    if not (RUN / 'profile').exists():
        raise SystemExit('chaos: no recorded impairment profile; run `impair <profile|clear>` first so heals restore it')
    end = time.time() + a.duration
    rnd = random.Random(a.seed)
    log = RUN / 'chaos.log'
    with log.open('a') as f:
        while time.time() < end:
            link = rnd.choice(CORE_LINKS)
            mode = a.mode if a.mode != 'mixed' else rnd.choice(['carrier', 'blackhole'])
            set_link_fault(link, mode, True)
            f.write(f'{time.strftime("%H:%M:%S")} fail {link} {mode}\n'); f.flush()
            time.sleep(a.down)
            set_link_fault(link, mode, False)
            f.write(f'{time.strftime("%H:%M:%S")} heal {link} {mode}\n'); f.flush()
            time.sleep(max(0, a.every - a.down))


def cmd_deploy_vortex(a) -> None:
    repo = Path(a.repo).resolve()
    bun = Path(shutil.which('bun') or '').resolve()
    if not (repo / 'v6' / 'tools' / 'device-hub.ts').exists() or not bun.exists():
        raise SystemExit('need REPO with v6/tools/device-hub.ts and bun on PATH')
    stage = RUN / 'stage'
    shutil.rmtree(stage, ignore_errors=True)
    (stage / 'vx').mkdir(parents=True)
    shutil.copytree(repo / 'v6', stage / 'vx' / 'v6', ignore=shutil.ignore_patterns('dist', 'node_modules', '*.test.ts'))
    shutil.copy(bun, stage / 'vx' / 'bun')
    tar = RUN / 'vx.tgz'
    sh(['tar', '-C', str(stage), '-czf', str(tar), 'vx'])
    for n in ['hub', 'peer-a', 'peer-b']:
        scp_to(n, str(tar), '/tmp/vx.tgz')
        ssh(n, 'rm -rf ~/vx && tar -C ~ -xzf /tmp/vx.tgz && ~/vx/bun --version')
    # Stop the previous hub by PID (a pattern kill would match this SSH shell itself),
    # then wipe and verify its state, so every deploy is a genuinely fresh hub.
    ssh('hub', '[ -f ~/hub.pid ] && kill $(cat ~/hub.pid) 2>/dev/null; sleep 1; rm -f ~/hub.pid', check=False)
    ssh('hub', 'rm -rf ~/hubdir && [ ! -e ~/hubdir ] && ! ss -ltn | grep -q ":7844 "')
    ssh('hub', 'cd ~/vx && setsid -f sh -c \'echo $$ > ~/hub.pid; exec ./bun v6/tools/device-hub.ts --dir ~/hubdir --tls 10.10.9.10:7844' + (f' --loop-limit {a.loop_limit}' if a.loop_limit else '') + (f' --wake-hourly-limit {a.wake_hourly_limit}' if a.wake_hourly_limit else '') + ' > ~/hub.log 2>&1 < /dev/null\'; '
               'for i in $(seq 50); do [ -s ~/hubdir/dev-b.json ] && break; sleep 0.2; done; cat ~/hub.log')
    for who, node in [('dev-a', 'peer-a'), ('dev-b', 'peer-b')]:
        scp_from('hub', f'hubdir/{who}.json', str(RUN / f'{who}.json'))
        scp_to(node, str(RUN / f'{who}.json'), f'{who}.json')
    print('deployed: hub at wss://10.10.9.10:7844 (pinned TLS); dev-a -> peer-a, dev-b -> peer-b')


def cmd_peer_check(a) -> None:
    ev = RUN / 'evidence'
    ev.mkdir(exist_ok=True)
    tag = time.strftime('%Y%m%dT%H%M%S')
    timeout_ms = max(120_000, a.rounds * 20_000)
    ssh('peer-b', f'cd ~/vx && setsid -f ./bun v6/tools/peer-check.ts --credential ~/dev-b.json --role respond --peer dev-a '
                  f'--timeout-ms {timeout_ms + 60_000} --out ~/b.evidence > ~/b.out 2>&1 < /dev/null &')
    time.sleep(3)
    t0 = time.time()
    out = ssh('peer-a', f'cd ~/vx && ./bun v6/tools/peer-check.ts --credential ~/dev-a.json --role initiate --peer dev-b '
                        f'--rounds {a.rounds} --timeout-ms {timeout_ms} --out ~/a.evidence; echo EXIT=$?', check=False,
              timeout=timeout_ms // 1000 + 120)
    print(out.strip()[-1500:])
    for i in range(60):
        if 'ok' in ssh('peer-b', 'cat ~/b.out 2>/dev/null', check=False):
            break
        time.sleep(2)
    for who, node in [('a', 'peer-a'), ('b', 'peer-b')]:
        scp_from(node, f'{who}.evidence', str(ev / f'{tag}-{who}.json'))
    print(f'elapsed {time.time() - t0:.0f}s; evidence {ev}/{tag}-a.json, {tag}-b.json')


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest='cmd', required=True)
    sp.add_parser('build-base').set_defaults(f=cmd_build_base)
    sp.add_parser('up').set_defaults(f=cmd_up)
    sp.add_parser('down').set_defaults(f=cmd_down)
    sp.add_parser('status').set_defaults(f=cmd_status)
    s = sp.add_parser('ssh'); s.add_argument('node', choices=ORDER); s.add_argument('command', nargs='+'); s.set_defaults(f=cmd_ssh)
    s = sp.add_parser('impair'); s.add_argument('profile', choices=[*PROFILES, 'clear']); s.set_defaults(f=cmd_impair)
    s = sp.add_parser('chaos'); s.add_argument('--duration', type=int, default=300); s.add_argument('--every', type=int, default=45)
    s.add_argument('--down', type=int, default=15); s.add_argument('--seed', type=int, default=6)
    s.add_argument('--mode', choices=['carrier', 'blackhole', 'mixed'], default='mixed'); s.set_defaults(f=cmd_chaos)
    s = sp.add_parser('deploy-vortex'); s.add_argument('repo'); s.add_argument('--loop-limit', type=int, default=None); s.add_argument('--wake-hourly-limit', type=int, default=None); s.set_defaults(f=cmd_deploy_vortex)
    s = sp.add_parser('peer-check'); s.add_argument('--rounds', type=int, default=10); s.set_defaults(f=cmd_peer_check)
    a = p.parse_args()
    a.f(a)


if __name__ == '__main__':
    main()
