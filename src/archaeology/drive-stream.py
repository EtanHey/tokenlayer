#!/usr/bin/env python3
"""Stream Drive alt=media to stdout or select one tar member in memory. Never extract."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile

class DigestStream:
    def __init__(self, raw):
        self.raw, self.sha, self.md5, self.size = raw, hashlib.sha256(), hashlib.md5(), 0
    def read(self, n=-1):
        value = self.raw.read(n)
        self.sha.update(value); self.md5.update(value); self.size += len(value)
        return value

def stream_bytes(raw, output, expected_sha=None, expected_md5=None, member=None, member_sha=None):
    stream, sent = DigestStream(raw), False
    if member:
        if not member_sha: raise ValueError('member SHA256 required')
        with tarfile.open(fileobj=stream, mode='r|*') as archive:
            for info in archive:
                if info.name != member or not info.isfile(): continue
                if info.size > 1024**3: raise ValueError('member exceeds 1 GiB memory guard')
                value = archive.extractfile(info).read()
                if hashlib.sha256(value).hexdigest() == member_sha and not sent:
                    output.write(value); sent = True
    while True:
        chunk = stream.read(1024*1024)
        if not chunk: break
        if not member: output.write(chunk)
    if expected_sha and stream.sha.hexdigest() != expected_sha: raise ValueError('container SHA256 mismatch')
    if expected_md5 and stream.md5.hexdigest() != expected_md5: raise ValueError('container MD5 mismatch')
    if member and not sent: raise ValueError('member identity not found')
    return dict(bytes=stream.size, sha256=stream.sha.hexdigest(), md5=stream.md5.hexdigest())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file-id', required=True)
    parser.add_argument('--sha256'); parser.add_argument('--md5')
    parser.add_argument('--member'); parser.add_argument('--member-sha256')
    args = parser.parse_args()
    if os.environ.get('USER') == 'happycampr': raise RuntimeError('Phase 4 fetch is M4-only')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', args.file_id): raise ValueError('invalid Drive file id')
    for value, size in [(args.sha256,64),(args.md5,32),(args.member_sha256,64)]:
        if value and not re.fullmatch('[a-f0-9]{'+str(size)+'}',value): raise ValueError('invalid expected hash')
    sys.path.insert(0, os.environ.get('BRAINLAYER_SRC', str(Path.home()/'Gits/brainlayer/src')))
    from brainlayer.drive_credentials import load_credentials
    from google.auth.transport.requests import AuthorizedSession
    credentials = load_credentials(migrate=False, persist_refresh=False, alert_reporter=lambda *args: None)
    with AuthorizedSession(credentials) as session:
        with session.get('https://www.googleapis.com/drive/v3/files/'+args.file_id, params={'alt':'media'}, headers={'Accept-Encoding':'identity'}, stream=True, timeout=120) as response:
            if response.status_code != 200: raise RuntimeError('Drive HTTP '+str(response.status_code))
            receipt = stream_bytes(response.raw, sys.stdout.buffer, args.sha256, args.md5, args.member, args.member_sha256)
    sys.stdout.buffer.flush()
    sys.stderr.write(json.dumps(receipt)+'\n')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        # HTTP/auth exceptions may contain private data. Print the class only.
        sys.stderr.write('drive stream failed: '+type(error).__name__+'\n')
        sys.exit(1)
