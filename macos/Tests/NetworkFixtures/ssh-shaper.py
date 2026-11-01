#!/usr/bin/python3
"""Test-only SSH ProxyCommand. Ordered byte-stream delay/rate/stall injection.
This does NOT drop IP packets: periodic stalls approximate retransmission delay.
Profile is re-read to support offline/recovery without changing system networking.
"""
import collections, json, os, selectors, socket, sys, time
profile_path, host, port = sys.argv[1:]
def profile():
    try:
        with open(profile_path) as f: return json.load(f)
    except (OSError, ValueError): return {}
p = profile()
if p.get('offline'): sys.exit(1)
sock = socket.create_connection((host, int(port)), timeout=10)
sock.setblocking(False)
os.set_blocking(0, False); os.set_blocking(1, False)
sel = selectors.DefaultSelector()
sel.register(0, selectors.EVENT_READ, 0); sel.register(sock, selectors.EVENT_READ, 1)
queues = [collections.deque(), collections.deque()]
next_send = [0., 0.]; counts = [0, 0]; queued = [0, 0]
try:
    while True:
        p = profile()
        if p.get('offline'): break
        if p.get('blackhole'):
            time.sleep(.05)
            continue
        now = time.monotonic()
        # Bounded buffering provides backpressure during constrained bandwidth.
        for key, _ in sel.select(.005):
            direction = key.data
            if queued[direction] > 262144: continue
            data = os.read(0, 16384) if direction == 0 else sock.recv(16384)
            if not data: sys.exit(0)
            counts[direction] += 1
            due = max(now + p.get('delay_ms', 0) / 1000, next_send[direction])
            rate = p.get('bytes_per_second', 0)
            if rate: due += len(data) / rate
            every = p.get('stall_every', 0)
            if every and counts[direction] % every == 0: due += p.get('stall_ms', 0) / 1000
            next_send[direction] = due
            queues[direction].append([due, data]); queued[direction] += len(data)
        for direction in (0, 1):
            q = queues[direction]
            if q and q[0][0] <= time.monotonic():
                data = q[0][1]
                try: sent = sock.send(data) if direction == 0 else os.write(1, data)
                except BlockingIOError: continue
                queued[direction] -= sent
                if sent == len(data): q.popleft()
                else: q[0][1] = data[sent:]
except (OSError, BrokenPipeError):
    pass
finally:
    sock.close()
