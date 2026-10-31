"""Private SSH task transport. No TCP listener, credentials, or project installation."""
import fcntl
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.expanduser('~/.local/state/remotecc/tasks')
BUNDLES = os.path.expanduser('~/.local/share/remotecc')
os.umask(0o077)


def atomic(filename, data):
    temporary = filename + '.' + str(os.getpid()) + '.tmp'
    with open(temporary, 'w') as target:
        json.dump(data, target)
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, filename)


def task_path(identifier):
    if not re.fullmatch(r'[a-f0-9-]{36}', identifier):
        raise ValueError('Invalid task ID')
    return os.path.join(ROOT, identifier)


def supervise(folder, bundle):
    with open(os.path.join(folder, 'run.lock'), 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state_file = os.path.join(folder, 'state.json')
        if os.path.exists(state_file):
            with open(state_file) as source:
                if json.load(source).get('done'):
                    return
            # Never replay a request whose previous owner died after dispatch.
            state = json.load(open(state_file))
            idle = state.get('resident') and state.get('status') in ('idle', 'stopped')
            state.update(done=True, status=state['status'] if idle else 'error', permissions=[], version=state['version'] + 1)
            if not idle:
                state['message']['error'] = '远端任务进程已退出，未自动重新执行。'
            atomic(state_file, state)
            return
        started = os.path.join(folder, 'started.json')
        if os.path.exists(started):
            request = json.load(open(os.path.join(folder, 'request.json')))
            state = dict(version=1, done=True, status='error', permissions=[], message=request['session']['messages'][-1])
            state['message']['error'] = '上次远端任务启动结果未知，未自动重复执行。'
            atomic(state_file, state)
            return
        atomic(started, True)
        try:
            code = subprocess.run(['node', os.path.join(bundle, 'task-worker.cjs'), folder]).returncode
        except OSError as error:
            print(str(error), file=sys.stderr)
            code = 127
        state = json.load(open(state_file)) if os.path.exists(state_file) else None
        if not state or not state.get('done'):
            request = json.load(open(os.path.join(folder, 'request.json')))
            state = state or dict(version=0, message=request['session']['messages'][-1])
            state.update(done=True, status='error', permissions=[], version=state['version'] + 1)
            state['message']['error'] = '远端任务进程异常退出（%s）' % code
            atomic(state_file, state)


def prune_completed():
    if not os.path.isdir(ROOT):
        return
    import shutil
    for entry in os.scandir(ROOT):
        if not entry.is_dir(follow_symlinks=False):
            continue
        state_file = os.path.join(entry.path, 'state.json')
        try:
            if time.time() - os.stat(state_file).st_mtime < 7 * 86400:
                continue
            with open(state_file) as source:
                state = json.load(source)
            if state.get('done') and os.path.exists(os.path.join(entry.path, 'acknowledged')):
                shutil.rmtree(entry.path)
        except (OSError, ValueError):
            pass


def state_delta(previous, current, path=None):
    path = path or []
    if previous == current:
        return []
    if isinstance(previous, str) and isinstance(current, str) and current.startswith(previous):
        return [dict(path=path, append=current[len(previous):])]
    if isinstance(previous, dict) and isinstance(current, dict):
        patches = [dict(path=path + [key], remove=True) for key in previous if key not in current]
        for key, value in current.items():
            patches.extend(state_delta(previous[key], value, path + [key]) if key in previous else [dict(path=path + [key], value=value)])
        return patches
    if isinstance(previous, list) and isinstance(current, list) and len(current) >= len(previous):
        patches = []
        for index, value in enumerate(current):
            patches.extend(state_delta(previous[index], value, path + [index]) if index < len(previous) else [dict(path=path + [index], value=value)])
        return patches
    return [dict(path=path, value=current)]


def dispatch(request):
    operation = request['operation']
    if operation in ('installed', 'install'):
        prune_completed()
        digest = request['digest']
        if not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('Invalid bundle')
        bundle = os.path.join(BUNDLES, digest)
        marker = os.path.join(bundle, 'ready')
        if operation == 'install' and not os.path.exists(marker):
            import base64
            payload = gzip.decompress(base64.b64decode(request['payload']))
            if hashlib.sha256(payload).hexdigest() != digest:
                raise ValueError('Bundle checksum mismatch')
            os.makedirs(bundle, mode=0o700, exist_ok=True)
            for name, content in json.loads(payload).items():
                if os.path.basename(name) != name:
                    raise ValueError('Invalid bundle filename')
                with open(os.path.join(bundle, name), 'w') as target:
                    target.write(content)
            atomic(marker, True)
        return dict(installed=os.path.exists(marker))
    folder = task_path(request['taskId'])
    if operation == 'start':
        os.makedirs(folder, mode=0o700, exist_ok=True)
        os.makedirs(os.path.join(folder, 'commands'), mode=0o700, exist_ok=True)
        with open(os.path.join(folder, 'start.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            filename = os.path.join(folder, 'request.json')
            if not os.path.exists(filename):
                value = request['request']
                value['session']['directory'] = os.path.abspath(os.path.expanduser(value['session']['directory']))
                atomic(filename, value)
            digest = request['digest']
            if not re.fullmatch(r'[a-f0-9]{64}', digest):
                raise ValueError('Invalid bundle')
            bundle = os.path.join(BUNDLES, digest)
            with open(os.path.join(folder, 'worker.log'), 'ab') as log:
                subprocess.Popen(['python3', os.path.join(bundle, 'task-bridge.py'), 'supervise', folder, bundle],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        return dict(started=True)
    if operation == 'acknowledge':
        atomic(os.path.join(folder, 'acknowledged'), True)
        return dict(accepted=True)
    if operation == 'command':
        identifier = request['commandId']
        if not re.fullmatch(r'[a-f0-9-]{36}', identifier):
            raise ValueError('Invalid command ID')
        filename = os.path.join(folder, 'commands', identifier + '.json')
        if not os.path.exists(filename + '.done') and not os.path.exists(filename + '.result'):
            atomic(filename, request['command'])
        if request.get('wait'):
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if os.path.exists(filename + '.result'):
                    return json.load(open(filename + '.result'))
                state_file = os.path.join(folder, 'state.json')
                if os.path.exists(state_file) and json.load(open(state_file)).get('done'):
                    return dict(ok=False, error='远端会话已退出')
                time.sleep(0.1)
            return dict(ok=False, uncertain=True, error='远端操作确认超时，请重连后检查会话状态')
        return dict(accepted=True)
    if operation == 'watch':
        version = -1
        previous = None
        signature = None
        heartbeat = time.monotonic()
        while True:
            filename = os.path.join(folder, 'state.json')
            info = os.stat(filename) if os.path.exists(filename) else None
            current_signature = (info.st_mtime_ns, info.st_size, info.st_ino) if info else None
            if info and current_signature != signature:
                signature = current_signature
                with open(filename) as source:
                    state = json.load(source)
                if state['version'] != version:
                    packet = state
                    if previous is not None:
                        delta = dict(delta=True, base=version, version=state['version'], patches=state_delta(previous, state))
                        if len(json.dumps(delta)) < len(json.dumps(state)):
                            packet = delta
                    print(json.dumps(packet, ensure_ascii=False), flush=True)
                    version = state['version']
                    previous = state
                if state.get('done'):
                    return None
            if time.monotonic() - heartbeat > 10:
                print(json.dumps(dict(heartbeat=True)), flush=True)
                heartbeat = time.monotonic()
            time.sleep(0.25)
    raise ValueError('Unknown task operation')


if __name__ == '__main__':
    try:
        if len(sys.argv) > 1 and sys.argv[1] == 'supervise':
            supervise(sys.argv[2], sys.argv[3])
        else:
            result = dispatch(json.load(sys.stdin))
            if result is not None:
                print(json.dumps(result))
    except BrokenPipeError:
        pass  # Losing a subscription must not terminate the owner process.
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
