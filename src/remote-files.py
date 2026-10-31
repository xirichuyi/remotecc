"""One-shot file operations over an authenticated SSH channel; no remote install."""
import base64
import codecs
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import subprocess


def resolve(value, base='~'):
    if not isinstance(value, str) or any(ord(char) < 32 for char in value):
        raise ValueError('无效路径')
    value = os.path.expanduser(value)
    if not os.path.isabs(value):
        value = os.path.join(os.path.expanduser(base), value)
    return os.path.abspath(value)


def metadata(filename):
    info = os.stat(filename)
    return dict(path=filename, name=os.path.basename(filename), size=info.st_size,
                directory=stat.S_ISDIR(info.st_mode), modified=info.st_mtime,
                symlink=os.path.islink(filename), version='%s:%s:%s:%s' % (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns))


def regular(filename):
    info = metadata(filename)
    if not stat.S_ISREG(os.stat(filename).st_mode):
        raise ValueError('请选择普通文件')
    return info


def listing(request):
    folder = resolve(request.get('path', '~'), request.get('base', '~'))
    entries = []
    with os.scandir(folder) as iterator:
        for entry in iterator:
            if not request.get('hidden') and entry.name.startswith('.'):
                continue
            try:
                entries.append(metadata(entry.path))
            except OSError:
                continue
    entries.sort(key=lambda item: (not item['directory'], item['name'].lower()))
    return dict(path=folder, parent=os.path.dirname(folder), entries=entries[:5000],
                truncated=len(entries) > 5000)


def preview(request):
    filename = resolve(request['path'], request.get('base', '~'))
    info = regular(filename)
    if request.get('knownVersion') == info['version']:
        return dict(info, notModified=True)
    with open(filename, 'rb') as source:
        magic = source.read(16)
        source.seek(0)
        mime = None
        if magic.startswith(b'\x89PNG\r\n\x1a\n'):
            mime = 'image/png'
        elif magic.startswith(b'\xff\xd8\xff'):
            mime = 'image/jpeg'
        elif magic.startswith((b'GIF87a', b'GIF89a')):
            mime = 'image/gif'
        elif magic.startswith(b'RIFF') and magic[8:12] == b'WEBP':
            mime = 'image/webp'
        elif magic.startswith(b'%PDF-'):
            mime = 'application/pdf'
        if mime and info['size'] <= 20 * 1024 * 1024:
            if request.get('metadataOnly'):
                return dict(info, kind='pdf' if mime == 'application/pdf' else 'image', mime=mime)
            return dict(info, kind='pdf' if mime == 'application/pdf' else 'image',
                        mime=mime, data=base64.b64encode(source.read()).decode('ascii'))
        if mime:
            return dict(info, kind='binary', reason='文件超过预览大小限制，请下载查看')
        data = source.read(1024 * 1024)
        try:
            text = codecs.getincrementaldecoder('utf-8')().decode(data, final=info['size'] <= len(data))
            if '\x00' in text:
                raise UnicodeError()
            return dict(info, kind='text', text=text, revision=hashlib.sha256(data).hexdigest(), truncated=info['size'] > len(data))
        except UnicodeError:
            return dict(info, kind='binary', reason='此格式请下载或在本地打开')


def upload(request):
    folder = resolve(request['directory'])
    name = request['name']
    if not name or name != os.path.basename(name) or name in ('.', '..') or any(ord(c) < 32 for c in name):
        raise ValueError('无效文件名')
    expected = request['size']
    if not isinstance(expected, int) or not 0 <= expected <= 1024 ** 3:
        raise ValueError('文件大小超出限制（1 GB）')
    destination = os.path.join(folder, name)
    descriptor, temporary = tempfile.mkstemp(prefix='.remotecc-upload-', dir=folder)
    try:
        with os.fdopen(descriptor, 'wb') as target:
            received = 0
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > expected:
                    raise ValueError('上传大小不匹配')
                target.write(chunk)
            if received != expected:
                raise ValueError('上传未完成')
            target.flush()
            os.fsync(target.fileno())
        # Atomic, no overwrite: a conflicting name fails even if created mid-upload.
        os.link(temporary, destination)
        return metadata(destination)
    finally:
        os.unlink(temporary)


def save_text(request):
    filename = os.path.realpath(resolve(request['path'], request.get('base', '~')))
    info = regular(filename)
    data = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError('编辑上限为 1 MB')
    data.decode('utf-8')
    def verify():
        with open(filename, 'rb') as source:
            current = source.read(1024 * 1024 + 1)
        if hashlib.sha256(current).hexdigest() != request.get('revision'):
            raise ValueError('远端文件已变化，请重新打开后编辑；本次修改未保存')
    verify()
    descriptor, temporary = tempfile.mkstemp(prefix='.remotecc-edit-', dir=os.path.dirname(filename))
    try:
        with os.fdopen(descriptor, 'wb') as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
            os.fchmod(target.fileno(), stat.S_IMODE(os.stat(filename).st_mode))
        verify()
        os.replace(temporary, filename)
        return preview(dict(request, path=filename))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def suggest(request):
    base = resolve(request.get('base', '~'))
    query = request.get('query', '').lower()
    results = []
    visited = 0
    deadline = time.monotonic() + 3
    excluded = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache'}
    for folder, directories, filenames in os.walk(base, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in excluded and not name.startswith('.'))
        for name in sorted(filenames):
            visited += 1
            filename = os.path.join(folder, name)
            relative = os.path.relpath(filename, base)
            if query in relative.lower() and not name.startswith('.'):
                try:
                    info = regular(filename)
                    results.append(dict(info, relative=relative))
                except OSError:
                    pass
                except ValueError:
                    pass
            if len(results) >= 40 or visited >= 20000 or time.monotonic() > deadline:
                return dict(files=results, truncated=True)
        if time.monotonic() > deadline:
            return dict(files=results, truncated=True)
    return dict(files=results, truncated=False)


def main():
    request = json.loads(sys.argv[1])
    operation = request['operation']
    if operation == 'hello':
        result = dict(home=os.path.expanduser('~'), hostname=os.uname().nodename)
    elif operation == 'list':
        result = listing(request)
    elif operation == 'preview':
        result = preview(request)
    elif operation == 'suggest':
        result = suggest(request)
    elif operation == 'save':
        result = save_text(request)
    elif operation == 'diff':
        folder = resolve(request.get('base', '~'))
        def git(*args):
            process = subprocess.run(['git', '--no-pager', *args], cwd=folder, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
            if process.returncode:
                raise ValueError(process.stderr.decode('utf-8', errors='replace'))
            return process.stdout[:2 * 1024 * 1024].decode('utf-8', errors='replace')
        result = dict(text='Working tree\n' + git('diff', '--no-ext-diff', '--no-textconv') + '\nStaged\n' + git('diff', '--cached', '--no-ext-diff', '--no-textconv') + '\nStatus\n' + git('status', '--short'))
    elif operation == 'stat':
        result = regular(resolve(request['path'], request.get('base', '~')))
    elif operation == 'upload':
        result = upload(request)
    elif operation == 'download':
        filename = resolve(request['path'], request.get('base', '~'))
        before = regular(filename)
        if request.get('version') and request['version'] != before['version']:
            raise ValueError('远端文件已变化，请重试')
        with open(filename, 'rb') as source:
            shutil.copyfileobj(source, sys.stdout.buffer, 1024 * 1024)
        if regular(filename)['version'] != before['version']:
            raise ValueError('传输期间远端文件已变化，请重试')
        return
    else:
        raise ValueError('未知操作')
    print(json.dumps(result, ensure_ascii=True))


try:
    main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
