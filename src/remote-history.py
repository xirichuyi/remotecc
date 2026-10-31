"""Read Claude history over SSH. Listing reads bounded metadata; messages are opt-in."""
import datetime
import json
import os
import re
import sys
import sqlite3
import hashlib
import time
import uuid

ROOT = os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR', '~/.claude')), 'projects')
UUID = re.compile(r'^[0-9a-fA-F-]{36}$')
WINDOW = 65536
MAX_LINE = 16 * 1024 * 1024


def entries():
    result = []
    if not os.path.isdir(ROOT):
        return result
    for project in os.scandir(ROOT):
        if not project.is_dir(follow_symlinks=False):
            continue
        for item in os.scandir(project.path):
            if item.name.endswith('.jsonl') and UUID.fullmatch(item.name[:-6]) and item.is_file(follow_symlinks=False):
                info = item.stat()
                result.append((info.st_mtime, project.name + '/' + item.name, info.st_size))
    return sorted(result, reverse=True)


def resolve(reference):
    if not isinstance(reference, str):
        raise ValueError('无效历史会话')
    parts = reference.split('/')
    if len(parts) != 2 or parts[0] in ('', '.', '..') or not parts[1].endswith('.jsonl') or not UUID.fullmatch(parts[1][:-6]):
        raise ValueError('无效历史会话')
    filename = os.path.realpath(os.path.join(ROOT, reference))
    if os.path.commonpath([filename, os.path.realpath(ROOT)]) != os.path.realpath(ROOT):
        raise ValueError('历史路径越界')
    return filename


def parsed_lines(data):
    for line in data.splitlines():
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                yield row
        except (ValueError, UnicodeError):
            pass


def text_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(block.get('text', '') for block in content if isinstance(block, dict) and block.get('type') == 'text')
    return ''


def summary(reference, size, modified):
    with open(resolve(reference), 'rb') as source:
        head = source.read(WINDOW)
        if size > WINDOW:
            source.seek(max(WINDOW, size - WINDOW))
            tail = source.read(WINDOW).split(b'\n', 1)[-1]
        else:
            tail = b''
    title, prompt, cwd = '', '', ''
    for row in parsed_lines(head + b'\n' + tail):
        cwd = row.get('cwd') or cwd
        if row.get('type') == 'custom-title':
            title = row.get('customTitle') or title
        if row.get('type') == 'summary' and not title:
            title = row.get('summary') or title
        if row.get('type') == 'user' and not row.get('isSidechain') and not row.get('isMeta') and not prompt:
            prompt = text_content(row.get('message', {}).get('content'))[:200]
    return dict(reference=reference, sessionId=reference.split('/')[-1][:-6], directory=cwd,
                name=(title or prompt or reference.split('/')[-1][:-6])[:200],
                updatedAt=int(modified * 1000), size=size, project=reference.split('/')[0])


def database(name):
    folder = os.path.join(os.path.dirname(ROOT), 'remotecc-index')
    os.makedirs(folder, mode=0o700, exist_ok=True)
    filename = os.path.join(folder, name + '.sqlite')
    db = sqlite3.connect(filename, timeout=30)
    os.chmod(filename, 0o600)
    return db


def listing(request):
    with database('listing') as db:
        db.execute('CREATE TABLE IF NOT EXISTS summaries (ref TEXT PRIMARY KEY, signature TEXT, data TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, created REAL, data TEXT)')
        offset = request.get('offset', 0)
        if isinstance(offset, str):
            token, position = offset.split(':')
            position = int(position)
            saved = db.execute('SELECT data FROM snapshots WHERE id=? AND created>?', (token, time.time() - 3600)).fetchone()
            if not saved or position < 0:
                raise ValueError('历史列表已过期，请刷新历史')
            rows, errors = json.loads(saved[0])
        else:
            position = max(0, int(offset))
            rows, errors = [], []
            for modified, reference, size in entries():
                try:
                    stat = os.stat(resolve(reference))
                    signature = str((stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
                    cached = db.execute('SELECT data FROM summaries WHERE ref=? AND signature=?', (reference, signature)).fetchone()
                    item = json.loads(cached[0]) if cached else summary(reference, size, modified)
                    if not cached:
                        db.execute('INSERT OR REPLACE INTO summaries VALUES (?,?,?)', (reference, signature, json.dumps(item)))
                    rows.append(item)
                except OSError:
                    errors.append(reference)
            token = uuid.uuid4().hex
            db.execute('DELETE FROM snapshots WHERE created<?', (time.time() - 3600,))
            db.execute('INSERT INTO snapshots VALUES (?,?,?)', (token, time.time(), json.dumps([rows, errors])))
        end = position + 200
        return dict(sessions=rows[position:end], nextOffset=token + ':' + str(end) if end < len(rows) else None,
                    total=len(rows) + len(errors), unreadable=errors if position == 0 else [], metadataBytesPerSession=WINDOW * 2)


class Nodes:
    def __init__(self, db):
        self.db = db
    def __contains__(self, key):
        return self.db.execute('SELECT 1 FROM nodes WHERE id=?', (key,)).fetchone() is not None
    def __getitem__(self, key):
        return self.db.execute('SELECT parent, position, visible FROM nodes WHERE id=?', (key,)).fetchone()


def fingerprint(source, end):
    source.seek(0)
    head = source.read(min(end, 4096))
    source.seek(max(0, end - 4096))
    return hashlib.sha256(head + source.read(min(end, 4096))).hexdigest()


def indexed_nodes(source, db):
    db.execute('CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, parent TEXT, position INTEGER, visible INTEGER)')
    db.execute('CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, data TEXT)')
    saved = db.execute('SELECT data FROM metadata WHERE id=1').fetchone()
    old = json.loads(saved[0]) if saved else {}
    stat = os.fstat(source.fileno())
    signature = [stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
    if old.get('signature') == signature:
        return Nodes(db), old['leaf'], old['cwd'], old['skipped']
    # Reuse only complete lines, checking both ends of the previous indexed prefix.
    append = (old and old['signature'][0] == stat.st_ino and stat.st_size > old['signature'][1]
              and fingerprint(source, old['end']) == old['fingerprint'])
    if append:
        leaf, cwd, skipped, end = old['leaf'], old['cwd'], old['skipped'], old['end']
    else:
        db.execute('DELETE FROM nodes')
        leaf, cwd, skipped, end = None, '', 0, 0
    source.seek(end)
    while True:
        position, row, more = read_row(source)
        if not more:
            break
        # A writer may be halfway through a JSON line. Revisit it on the next request.
        current = source.tell()
        source.seek(current - 1)
        complete = source.read(1) == b'\n'
        source.seek(current)
        if not complete:
            break
        end = current
        if row is None:
            skipped += 1
            continue
        cwd = row.get('cwd') or cwd
        identifier = row.get('uuid')
        if isinstance(identifier, str) and not row.get('isSidechain'):
            visible = row.get('type') in ('user', 'assistant') and not row.get('isMeta')
            db.execute('INSERT OR REPLACE INTO nodes VALUES (?,?,?,?)', (identifier, row.get('parentUuid'), position, visible))
            if visible:
                leaf = identifier
    if db.execute('SELECT COUNT(*) FROM nodes').fetchone()[0] > 500000:
        raise ValueError('历史记录过大，当前预览最多索引 50 万条记录')
    metadata = dict(signature=signature, leaf=leaf, cwd=cwd, skipped=skipped, end=end, fingerprint=fingerprint(source, end))
    db.execute('INSERT OR REPLACE INTO metadata VALUES (1,?)', (json.dumps(metadata),))
    return Nodes(db), leaf, cwd, skipped


def read_row(source):
    offset = source.tell()
    data = source.readline(MAX_LINE + 1)
    if len(data) > MAX_LINE:
        while data and not data.endswith(b'\n'):
            data = source.readline(MAX_LINE + 1)
        return offset, None, True
    if not data:
        return offset, None, False
    try:
        row = json.loads(data)
        return offset, row if isinstance(row, dict) else None, True
    except (ValueError, UnicodeError):
        return offset, None, True


def safe_record(row):
    message = row.get('message', {})
    content = message.get('content', [])
    if isinstance(content, str):
        content = [dict(type='text', text=content[:40000])]
    blocks = []
    for block in content if isinstance(content, list) else []:
        kind = block.get('type') if isinstance(block, dict) else None
        if kind == 'text':
            blocks.append(dict(type='text', text=str(block.get('text', ''))[:40000]))
        elif kind == 'thinking':
            blocks.append(dict(type='thinking', thinking=str(block.get('thinking', ''))[:40000]))
        elif kind == 'tool_use':
            value = block.get('input', {})
            if len(json.dumps(value)) > 20000:
                value = {'preview': '工具参数过长，历史预览已省略'}
            blocks.append(dict(type=kind, id=block.get('id'), name=block.get('name'), input=value))
        elif kind == 'tool_result':
            result = block.get('content', '')
            text = result if isinstance(result, str) else text_content(result)
            blocks.append(dict(type=kind, tool_use_id=block.get('tool_use_id'), content=text[:20000], is_error=block.get('is_error', False)))
        elif kind in ('image', 'document'):
            blocks.append(dict(type='text', text='[历史附件：' + kind + '，未下载原始数据]'))
        if len(json.dumps(blocks)) > 80000:
            blocks.pop()
            blocks.append(dict(type='text', text='[历史消息过长，其余内容已省略]'))
            break
        if len(blocks) >= 100:
            break
    return dict(type=row['type'], uuid=row['uuid'], timestamp=row.get('timestamp'),
                message=dict(id=message.get('id') or row['uuid'], content=blocks))


def messages(request):
    filename = resolve(request['reference'])
    name = hashlib.sha256(request['reference'].encode()).hexdigest()
    with database(name) as db, open(filename, 'rb') as source:
        nodes, leaf, cwd, skipped = indexed_nodes(source, db)
        before = request.get('before')
        if before and before not in nodes:
            raise ValueError('历史已变化，请重新打开会话')
        cursor = nodes[before][0] if before else leaf
        chosen, seen = [], set()
        while cursor and cursor in nodes and cursor not in seen:
            seen.add(cursor)
            parent, position, visible = nodes[cursor]
            if visible:
                chosen.append((cursor, position))
                if len(chosen) == 50:
                    break
            cursor = parent
        result = []
        for identifier, position in reversed(chosen):
            source.seek(position)
            _, row, _ = read_row(source)
            result.append(safe_record(row))
        oldest = chosen[-1][0] if chosen else None
        cursor = nodes[oldest][0] if oldest else None
        seen = set()
        has_more = False
        while cursor and cursor in nodes and cursor not in seen:
            seen.add(cursor)
            if nodes[cursor][2]:
                has_more = True
                break
            cursor = nodes[cursor][0]
    return dict(records=result, directory=cwd, before=oldest if has_more else None,
                skippedRecords=skipped, previewLimits=True)


try:
    request = json.loads(sys.argv[1])
    operation = request['operation']
    if operation == 'list':
        result = listing(request)
    elif operation == 'messages':
        result = messages(request)
    else:
        raise ValueError('未知历史操作')
    print(json.dumps(result, ensure_ascii=True))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
