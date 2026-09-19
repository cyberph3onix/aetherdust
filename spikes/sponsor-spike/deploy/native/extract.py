import tarfile, sys
src, dest = sys.argv[1], sys.argv[2]
with tarfile.open(src) as t:
    for m in t.getmembers():
        m.mode = 0o755 if m.isdir() else (m.mode | 0o600)
        try: t.extract(m, dest, filter='fully_trusted')
        except Exception as e: print('skip', m.name, e)
