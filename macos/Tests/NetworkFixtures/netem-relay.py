#!/usr/bin/python3
"""Test-only relay: real TCP packet loss inside a disposable network namespace.
The upstream SSH socket is opened before unshare; host networking is untouched.
"""
import ctypes, os, select, socket, subprocess, sys, threading
port = int(os.environ['SSH_CONNECTION'].split()[-1])
upstream = socket.create_connection(('127.0.0.1', port), timeout=10)
upstream.setblocking(True)
libc = ctypes.CDLL(None, use_errno=True)
if libc.unshare(0x40000000) != 0: raise OSError(ctypes.get_errno(), 'unshare network')
subprocess.run(['ip', 'link', 'set', 'lo', 'up', 'mtu', sys.argv[1] if len(sys.argv) > 1 else '1500'], check=True)
subprocess.run(['tc', 'qdisc', 'add', 'dev', 'lo', 'root', 'netem', 'delay', '50ms', 'loss', '2%'], check=True)
listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(1)
client = socket.create_connection(listener.getsockname())
server, _ = listener.accept(); listener.close()
client.setblocking(True)
def record_stats():
    while True:
        try:
            data = subprocess.check_output(['tc', '-s', '-j', 'qdisc', 'show', 'dev', 'lo'])
            with open(sys.argv[0] + '.stats.tmp', 'wb') as f: f.write(data)
            os.replace(sys.argv[0] + '.stats.tmp', sys.argv[0] + '.stats')
        except OSError: pass
        threading.Event().wait(.2)
threading.Thread(target=record_stats, daemon=True).start()
def bridge(a, b):
    try:
        while True:
            data = os.read(a, 16384)
            if not data: break
            while data:
                written = os.write(b, data); data = data[written:]
    except OSError: pass
    finally:
        # Closing any direction tears down only this dedicated relay.
        os._exit(0)
for a,b in [(0, client.fileno()), (client.fileno(), 1), (server.fileno(), upstream.fileno()), (upstream.fileno(), server.fileno())]:
    threading.Thread(target=bridge, args=(a,b), daemon=True).start()
threading.Event().wait()
